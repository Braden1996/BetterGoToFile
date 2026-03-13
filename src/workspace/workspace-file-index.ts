import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceIndexConfig } from "../config/schema";
import { defaultSort, type FileEntry } from "./file-entry";
import {
  mergeWorkspaceIndexRefreshRequests,
  type WorkspaceIndexRefreshRequest,
} from "./index-refresh-plan";
import { createPathGlobMatcher, type PathGlobMatcher } from "./path-glob";
import {
  createEmptyIndexedRoot,
  createIndexedDirectoryNode,
  createIndexedRootFromFilePaths,
  createIndexedFileNode,
  createWorkspaceFolderIndexSnapshot,
  type IndexedDirectoryNode,
  getIndexedDirectory,
  collectIndexedFileEntries,
  replaceIndexedDirectory,
  type WorkspaceFolderIndexSnapshot,
} from "./workspace-index-snapshot";
import { loadWorkspaceFilePathsFromGit, resolveRepoRoot } from "./git-utils";
import { WorkspaceIndexPersistence } from "./workspace-index-persistence";
import { normalizeDirectory, normalizePath } from "./workspace-path";

export interface WorkspaceFileIndexStatus {
  readonly isIndexing: boolean;
  readonly indexedFileCount: number;
  readonly maxFileCount: number;
  readonly workspaceFolderCount: number;
  readonly isAtFileLimit: boolean;
  readonly currentSource: "empty" | "cache" | "live";
  readonly isRestoringSnapshot: boolean;
  readonly isPersistingSnapshot: boolean;
  readonly lastRefreshStartedAt?: number;
  readonly lastRefreshCompletedAt?: number;
  readonly lastRefreshDurationMs?: number;
  readonly lastRefreshKind?: "full" | "partial";
  readonly restoredSnapshotAt?: number;
  readonly lastPersistedSnapshotAt?: number;
}

interface ScanBudget {
  remainingFiles: number | undefined;
  didHitLimit: boolean;
}

interface WorkspaceFileIndexOptions {
  readonly persistenceFilePath?: string;
  readonly log?: (message: string) => void;
}

interface GitWorkspacePathsResult {
  readonly paths: readonly string[];
  readonly isTruncated: boolean;
}

export class WorkspaceFileIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly entriesByPath = new Map<string, FileEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceSnapshots = new Map<string, WorkspaceFolderIndexSnapshot>();
  private watcherDisposable: vscode.Disposable | undefined;
  private config: WorkspaceIndexConfig;
  private fileMatcher: PathGlobMatcher;
  private excludedDirectories: ReadonlySet<string>;
  private readonly persistence: WorkspaceIndexPersistence;
  private readonly log?: (message: string) => void;
  private refreshQueue: WorkspaceIndexRefreshRequest[] = [];
  private refreshPromise = Promise.resolve();
  private isRefreshLoopScheduled = false;
  private sortedEntries: readonly FileEntry[] = [];
  private isRefreshing = false;
  private isMultiRoot = false;
  private isRestoringSnapshot = false;
  private currentSource: "empty" | "cache" | "live" = "empty";
  private lastRefreshStartedAt: number | undefined;
  private lastRefreshCompletedAt: number | undefined;
  private lastRefreshDurationMs: number | undefined;
  private lastRefreshKind: "full" | "partial" | undefined;
  private restoredSnapshotAt: number | undefined;
  private lastPersistedSnapshotAt: number | undefined;
  private isAtFileLimit = false;
  private initialReadyResolved = false;
  private readonly initialReadyPromise: Promise<void>;
  private resolveInitialReady!: () => void;

  readonly onDidChange = this.emitter.event;

  constructor(config: WorkspaceIndexConfig, options: WorkspaceFileIndexOptions = {}) {
    this.config = config;
    this.log = options.log;
    this.fileMatcher = createPathGlobMatcher(config.fileGlob);
    this.excludedDirectories = new Set(config.excludedDirectories);
    this.persistence = new WorkspaceIndexPersistence(options.persistenceFilePath, this.log);
    this.initialReadyPromise = new Promise((resolve) => {
      this.resolveInitialReady = resolve;
    });
    this.watcherDisposable = this.createWatcher();
    this.disposables.push(
      this.persistence,
      this.persistence.onDidPersist((persistedAt) => {
        this.lastPersistedSnapshotAt = persistedAt;
        this.emitter.fire();
      }),
    );
    void this.restoreSnapshotFromCache();
    this.enqueueRefresh({ kind: "full" });

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.enqueueRefresh({ kind: "full" });
      }),
    );
  }

  async ready(): Promise<void> {
    await this.initialReadyPromise;
  }

  getEntries(): readonly FileEntry[] {
    return this.sortedEntries;
  }

  getEntry(relativePath: string): FileEntry | undefined {
    return this.entriesByPath.get(relativePath);
  }

  getStatus(): WorkspaceFileIndexStatus {
    return {
      isIndexing: this.isRefreshing || this.refreshQueue.length > 0,
      indexedFileCount: this.sortedEntries.length,
      maxFileCount: this.config.maxFileCount,
      workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
      isAtFileLimit: this.isAtFileLimit,
      currentSource: this.currentSource,
      isRestoringSnapshot: this.isRestoringSnapshot,
      isPersistingSnapshot: this.persistence.getPendingSignature() !== undefined,
      lastRefreshStartedAt: this.lastRefreshStartedAt,
      lastRefreshCompletedAt: this.lastRefreshCompletedAt,
      lastRefreshDurationMs: this.lastRefreshDurationMs,
      lastRefreshKind: this.lastRefreshKind,
      restoredSnapshotAt: this.restoredSnapshotAt,
      lastPersistedSnapshotAt: this.lastPersistedSnapshotAt,
    };
  }

  async refreshNow(): Promise<void> {
    this.enqueueRefresh({ kind: "full" });
    await this.refreshPromise;
  }

  updateConfig(config: WorkspaceIndexConfig): void {
    const shouldRecreateWatcher = config.fileGlob !== this.config.fileGlob;

    this.config = config;
    this.fileMatcher = createPathGlobMatcher(config.fileGlob);
    this.excludedDirectories = new Set(config.excludedDirectories);

    if (shouldRecreateWatcher) {
      this.watcherDisposable?.dispose();
      this.watcherDisposable = this.createWatcher();
    }

    this.enqueueRefresh({ kind: "full" });
  }

  dispose(): void {
    this.watcherDisposable?.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.emitter.dispose();
  }

  private enqueueRefresh(request: WorkspaceIndexRefreshRequest): void {
    this.refreshQueue = mergeWorkspaceIndexRefreshRequests(this.refreshQueue, request);
    this.emitter.fire();

    this.ensureRefreshLoop();
  }

  private async drainRefreshQueue(): Promise<void> {
    while (true) {
      const request = this.refreshQueue.shift();

      if (!request) {
        return;
      }

      await this.runRefresh(request);
    }
  }

  private async runRefresh(request: WorkspaceIndexRefreshRequest): Promise<void> {
    this.isRefreshing = true;
    this.lastRefreshStartedAt = Date.now();
    this.emitter.fire();

    try {
      if (request.kind === "full") {
        await this.refreshAllWorkspaceFolders();
      } else {
        await this.refreshWorkspaceSubtree(request);
      }

      this.lastRefreshKind = request.kind;
      this.currentSource = (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? "live" : "empty";
      this.markInitialReady();
    } finally {
      const completedAt = Date.now();

      this.lastRefreshCompletedAt = completedAt;
      this.lastRefreshDurationMs = completedAt - (this.lastRefreshStartedAt ?? completedAt);
      this.isRefreshing = false;
      this.emitter.fire();
    }
  }

  private async refreshAllWorkspaceFolders(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders?.length) {
      this.isMultiRoot = false;
      this.workspaceSnapshots.clear();
      this.rebuildEntriesFromSnapshots();
      this.isAtFileLimit = false;
      this.currentSource = "empty";
      this.scheduleSnapshotPersist();
      this.log?.("Indexed 0 workspace files.");
      return;
    }

    this.isMultiRoot = folders.length > 1;

    const scanBudget = createScanBudget(this.config.maxFileCount);
    const nextSnapshots = new Map<string, WorkspaceFolderIndexSnapshot>();

    for (const folder of folders) {
      const snapshot =
        scanBudget.remainingFiles !== undefined && scanBudget.remainingFiles <= 0
          ? createWorkspaceFolderIndexSnapshot(folder, createEmptyIndexedRoot(folder.uri), true)
          : await this.indexWorkspaceFolder(folder, scanBudget);

      nextSnapshots.set(folder.uri.fsPath, snapshot);
    }

    this.workspaceSnapshots.clear();

    for (const folder of folders) {
      const snapshot = nextSnapshots.get(folder.uri.fsPath);

      if (snapshot) {
        this.workspaceSnapshots.set(folder.uri.fsPath, snapshot);
      }
    }

    this.rebuildEntriesFromSnapshots();
    this.isAtFileLimit = hasFileLimit(this.config.maxFileCount) && this.hasTruncatedSnapshots();
    this.scheduleSnapshotPersist();
    this.log?.(
      `Indexed ${this.sortedEntries.length} workspace files${this.isAtFileLimit ? " (capped)" : ""}.`,
    );
  }

  private async refreshWorkspaceSubtree(
    request: Extract<WorkspaceIndexRefreshRequest, { kind: "partial" }>,
  ): Promise<void> {
    this.isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (workspaceFolder) => workspaceFolder.uri.fsPath === request.workspaceFolderPath,
    );

    if (!folder) {
      return;
    }

    const currentSnapshot =
      this.workspaceSnapshots.get(folder.uri.fsPath) ??
      createWorkspaceFolderIndexSnapshot(folder, createEmptyIndexedRoot(folder.uri), false);
    const existingDirectory = getIndexedDirectory(currentSnapshot.root, request.relativeDirectory);
    const remainingFileBudget = getPartialRefreshBudget(
      this.config.maxFileCount,
      this.sortedEntries.length,
      existingDirectory?.fileCount ?? 0,
    );
    const scanBudget = createScanBudget(remainingFileBudget);
    const nextDirectory = await this.scanDirectoryTree(
      folder,
      request.relativeDirectory,
      scanBudget,
    );
    const nextRoot = replaceIndexedDirectory(
      currentSnapshot.root,
      request.relativeDirectory,
      nextDirectory,
    );
    const nextSnapshot = createWorkspaceFolderIndexSnapshot(
      folder,
      nextRoot,
      currentSnapshot.isTruncated || scanBudget.didHitLimit,
    );

    if (
      nextSnapshot.root.fingerprint === currentSnapshot.root.fingerprint &&
      nextSnapshot.isTruncated === currentSnapshot.isTruncated
    ) {
      return;
    }

    this.workspaceSnapshots.set(folder.uri.fsPath, nextSnapshot);
    this.rebuildEntriesFromSnapshots();
    this.isAtFileLimit = hasFileLimit(this.config.maxFileCount) && this.hasTruncatedSnapshots();
    this.scheduleSnapshotPersist();

    const scope = request.relativeDirectory || ".";

    this.log?.(`Refreshed index subtree ${scope}.`);
  }

  private rebuildEntriesFromSnapshots(): void {
    const snapshots = [...this.workspaceSnapshots.values()];
    const entries = [...collectIndexedFileEntries(snapshots, this.isMultiRoot)].sort(defaultSort);

    this.entriesByPath.clear();

    for (const entry of entries) {
      this.entriesByPath.set(entry.relativePath, entry);
    }

    this.sortedEntries = entries;
    this.isAtFileLimit = hasFileLimit(this.config.maxFileCount) && this.hasTruncatedSnapshots();
    this.emitter.fire();
  }

  private hasTruncatedSnapshots(): boolean {
    return [...this.workspaceSnapshots.values()].some((snapshot) => snapshot.isTruncated);
  }

  private async scanWorkspaceFolder(
    folder: vscode.WorkspaceFolder,
    scanBudget: ScanBudget,
  ): Promise<WorkspaceFolderIndexSnapshot> {
    const root =
      (await this.scanDirectoryTree(folder, "", scanBudget)) ?? createEmptyIndexedRoot(folder.uri);

    return createWorkspaceFolderIndexSnapshot(folder, root, scanBudget.didHitLimit);
  }

  private async indexWorkspaceFolder(
    folder: vscode.WorkspaceFolder,
    scanBudget: ScanBudget,
  ): Promise<WorkspaceFolderIndexSnapshot> {
    const gitSnapshot = await this.scanWorkspaceFolderFromGit(folder, scanBudget);

    if (gitSnapshot) {
      return gitSnapshot;
    }

    return this.scanWorkspaceFolder(folder, scanBudget);
  }

  private async scanWorkspaceFolderFromGit(
    folder: vscode.WorkspaceFolder,
    scanBudget: ScanBudget,
  ): Promise<WorkspaceFolderIndexSnapshot | undefined> {
    if (folder.uri.scheme !== "file") {
      return undefined;
    }

    try {
      const repoRootPath = await resolveRepoRoot(folder.uri.fsPath);
      const workspaceFolderPath = normalizePath(folder.uri.fsPath);
      const repoRelativeFolderPath = normalizePath(path.relative(repoRootPath, folder.uri.fsPath));

      if (repoRelativeFolderPath.startsWith("..")) {
        return undefined;
      }

      const gitPaths = await this.loadWorkspacePathsFromGit(
        repoRootPath,
        workspaceFolderPath,
        repoRelativeFolderPath === "." ? "" : repoRelativeFolderPath,
        scanBudget,
      );
      const root = createIndexedRootFromFilePaths(folder.uri, gitPaths.paths);

      if (gitPaths.paths.length === 0) {
        return createWorkspaceFolderIndexSnapshot(
          folder,
          createEmptyIndexedRoot(folder.uri),
          gitPaths.isTruncated,
        );
      }

      if (gitPaths.isTruncated) {
        scanBudget.didHitLimit = true;
      }

      this.log?.(`Indexed ${gitPaths.paths.length} Git-listed files for ${folder.name}.`);

      return createWorkspaceFolderIndexSnapshot(folder, root, gitPaths.isTruncated);
    } catch {
      return undefined;
    }
  }

  private async scanDirectoryTree(
    folder: vscode.WorkspaceFolder,
    relativeDirectory: string,
    scanBudget: ScanBudget,
  ): Promise<IndexedDirectoryNode | undefined> {
    if (scanBudget.remainingFiles !== undefined && scanBudget.remainingFiles <= 0) {
      scanBudget.didHitLimit = true;
      return undefined;
    }

    const directoryUri = toDirectoryUri(folder.uri, relativeDirectory);
    const entries = await this.readDirectory(directoryUri);

    if (!entries) {
      return relativeDirectory ? undefined : createEmptyIndexedRoot(folder.uri);
    }

    const directories = new Map<string, IndexedDirectoryNode>();
    const files = new Map<string, ReturnType<typeof createIndexedFileNode>>();

    for (const [name, fileType] of [...entries].sort(compareDirectoryEntries)) {
      if (isDirectoryEntry(fileType)) {
        if (isSymbolicLinkEntry(fileType) || this.excludedDirectories.has(name)) {
          continue;
        }

        const childRelativeDirectory = joinRelativePath(relativeDirectory, name);
        const childDirectory = await this.scanDirectoryTree(
          folder,
          childRelativeDirectory,
          scanBudget,
        );

        if (childDirectory && childDirectory.fileCount > 0) {
          directories.set(name, childDirectory);
        }

        continue;
      }

      if (!isFileEntry(fileType)) {
        continue;
      }

      const relativePath = joinRelativePath(relativeDirectory, name);

      if (!this.fileMatcher(relativePath)) {
        continue;
      }

      if (scanBudget.remainingFiles !== undefined && scanBudget.remainingFiles <= 0) {
        scanBudget.didHitLimit = true;
        break;
      }

      files.set(
        name,
        createIndexedFileNode({
          name,
          relativePath,
          uri: vscode.Uri.joinPath(directoryUri, name),
        }),
      );

      if (scanBudget.remainingFiles !== undefined) {
        scanBudget.remainingFiles -= 1;
      }
    }

    if (!relativeDirectory && !directories.size && !files.size) {
      return createEmptyIndexedRoot(folder.uri);
    }

    if (relativeDirectory && !directories.size && !files.size) {
      return undefined;
    }

    return createIndexedDirectoryNode({
      name: path.posix.basename(relativeDirectory),
      relativePath: relativeDirectory,
      uri: directoryUri,
      directories,
      files,
    });
  }

  private async readDirectory(
    directoryUri: vscode.Uri,
  ): Promise<readonly [string, vscode.FileType][] | undefined> {
    try {
      return await vscode.workspace.fs.readDirectory(directoryUri);
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.log?.(`Failed to read ${directoryUri.fsPath}: ${toErrorMessage(error)}`);
      }

      return undefined;
    }
  }

  private async loadWorkspacePathsFromGit(
    repoRootPath: string,
    workspaceFolderPath: string,
    repoRelativeFolderPath: string,
    scanBudget: ScanBudget,
  ): Promise<GitWorkspacePathsResult> {
    const relativePrefix = repoRelativeFolderPath ? `${repoRelativeFolderPath}/` : "";
    const paths: string[] = [];
    const seenPaths = new Set<string>();
    let isTruncated = false;

    for (const repoRelativePath of await loadWorkspaceFilePathsFromGit(
      repoRootPath,
      repoRelativeFolderPath,
    )) {
      const normalizedRepoRelativePath = normalizePath(repoRelativePath.trim());

      if (!normalizedRepoRelativePath) {
        continue;
      }

      let workspaceRelativePath = normalizedRepoRelativePath;

      if (relativePrefix) {
        if (!normalizedRepoRelativePath.startsWith(relativePrefix)) {
          continue;
        }

        workspaceRelativePath = normalizedRepoRelativePath.slice(relativePrefix.length);
      }

      if (
        !workspaceRelativePath ||
        seenPaths.has(workspaceRelativePath) ||
        !shouldIndexRelativePath(workspaceRelativePath, this.excludedDirectories) ||
        !this.fileMatcher(workspaceRelativePath)
      ) {
        continue;
      }

      if (scanBudget.remainingFiles !== undefined && scanBudget.remainingFiles <= 0) {
        isTruncated = true;
        break;
      }

      seenPaths.add(workspaceRelativePath);
      paths.push(workspaceRelativePath);

      if (scanBudget.remainingFiles !== undefined) {
        scanBudget.remainingFiles -= 1;
      }
    }

    paths.sort((left, right) => left.localeCompare(right));

    if (!paths.length && !repoRelativeFolderPath && workspaceFolderPath === repoRootPath) {
      return {
        paths,
        isTruncated,
      };
    }

    return {
      paths,
      isTruncated,
    };
  }

  private createWatcher(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(
      this.config.fileGlob,
      false,
      true,
      false,
    );

    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate((uri) => {
        this.scheduleSubtreeRefresh(uri);
      }),
      watcher.onDidDelete((uri) => {
        this.scheduleSubtreeRefresh(uri);
      }),
    );
  }

  private scheduleSubtreeRefresh(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);

    if (!folder) {
      return;
    }

    const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));

    if (!relativePath || !shouldIndexRelativePath(relativePath, this.excludedDirectories)) {
      return;
    }

    this.enqueueRefresh({
      kind: "partial",
      workspaceFolderPath: folder.uri.fsPath,
      relativeDirectory: normalizeDirectory(path.posix.dirname(relativePath)),
    });
  }

  private ensureRefreshLoop(): void {
    if (this.isRefreshLoopScheduled) {
      return;
    }

    this.isRefreshLoopScheduled = true;
    this.refreshPromise = this.refreshPromise.then(async () => {
      try {
        await this.drainRefreshQueue();
      } finally {
        this.isRefreshLoopScheduled = false;

        if (this.refreshQueue.length > 0) {
          this.ensureRefreshLoop();
        }
      }
    });
  }

  private async restoreSnapshotFromCache(): Promise<void> {
    this.isRestoringSnapshot = true;
    this.emitter.fire();

    try {
      const restored = await this.persistence.load(this.config, vscode.workspace.workspaceFolders);

      if (!restored || this.currentSource === "live") {
        return;
      }

      this.isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
      this.restoredSnapshotAt = restored.persistedAt;
      this.lastPersistedSnapshotAt = restored.persistedAt;
      this.currentSource = "cache";
      this.workspaceSnapshots.clear();

      for (const snapshot of restored.snapshots) {
        this.workspaceSnapshots.set(snapshot.workspaceFolderPath, snapshot);
      }

      this.rebuildEntriesFromSnapshots();
      this.isAtFileLimit = hasFileLimit(this.config.maxFileCount) && this.hasTruncatedSnapshots();
      this.log?.(`Restored ${this.sortedEntries.length} workspace files from snapshot cache.`);
      this.markInitialReady();
    } finally {
      this.isRestoringSnapshot = false;
      this.emitter.fire();
    }
  }

  private scheduleSnapshotPersist(): void {
    const snapshots = [...this.workspaceSnapshots.values()];

    this.persistence.schedulePersist(this.config, snapshots);
    this.emitter.fire();
  }

  private markInitialReady(): void {
    if (this.initialReadyResolved) {
      return;
    }

    this.initialReadyResolved = true;
    this.resolveInitialReady();
  }
}

function createScanBudget(fileLimit: number | undefined): ScanBudget {
  return {
    remainingFiles: fileLimit && fileLimit > 0 ? fileLimit : undefined,
    didHitLimit: false,
  };
}

function getPartialRefreshBudget(
  fileLimit: number,
  currentFileCount: number,
  replacedFileCount: number,
): number | undefined {
  if (!hasFileLimit(fileLimit)) {
    return undefined;
  }

  return Math.max(0, fileLimit - (currentFileCount - replacedFileCount));
}

function hasFileLimit(fileLimit: number): boolean {
  return fileLimit > 0;
}

function compareDirectoryEntries(
  left: readonly [string, vscode.FileType],
  right: readonly [string, vscode.FileType],
): number {
  return left[0].localeCompare(right[0]);
}

function isDirectoryEntry(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.Directory) === vscode.FileType.Directory;
}

function isFileEntry(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.File) === vscode.FileType.File;
}

function isSymbolicLinkEntry(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
}

function joinRelativePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function toDirectoryUri(workspaceFolderUri: vscode.Uri, relativeDirectory: string): vscode.Uri {
  if (!relativeDirectory) {
    return workspaceFolderUri;
  }

  return vscode.Uri.joinPath(workspaceFolderUri, ...relativeDirectory.split("/"));
}

function shouldIndexRelativePath(
  relativePath: string,
  excludedDirectories: ReadonlySet<string>,
): boolean {
  return relativePath.split("/").every((segment) => !excludedDirectories.has(segment));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /FileNotFound|EntryNotFound|no such file/i.test(error.message);
}
