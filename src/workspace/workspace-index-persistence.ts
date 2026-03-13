import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceIndexConfig } from "../config/schema";
import {
  createIndexedDirectoryNode,
  createIndexedFileNode,
  createWorkspaceFolderIndexSnapshot,
  type IndexedDirectoryNode,
  type WorkspaceFolderIndexSnapshot,
} from "./workspace-index-snapshot";

const CACHE_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 1500;

interface PersistedWorkspaceIndexSnapshot {
  readonly version: number;
  readonly persistedAt: number;
  readonly config: WorkspaceIndexConfig;
  readonly workspaceFolders: readonly PersistedWorkspaceFolderSnapshot[];
}

interface PersistedWorkspaceFolderSnapshot {
  readonly workspaceFolderPath: string;
  readonly isTruncated: boolean;
  readonly root: PersistedDirectoryNode;
}

interface PersistedDirectoryNode {
  readonly name: string;
  readonly relativePath: string;
  readonly directories: readonly PersistedDirectoryNode[];
  readonly files: readonly PersistedFileNode[];
}

interface PersistedFileNode {
  readonly name: string;
  readonly relativePath: string;
}

interface LoadedWorkspaceIndexSnapshot {
  readonly persistedAt: number;
  readonly snapshots: readonly WorkspaceFolderIndexSnapshot[];
}

export class WorkspaceIndexPersistence implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<number>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<number | undefined> = Promise.resolve(undefined);
  private pendingSnapshot: PersistedWorkspaceIndexSnapshot | undefined;
  private pendingSignature: string | undefined;
  private lastPersistedAt: number | undefined;
  private lastPersistedSignature: string | undefined;

  constructor(
    private readonly filePath: string | undefined,
    private readonly log?: (message: string) => void,
    private readonly flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  ) {}

  readonly onDidPersist = this.emitter.event;

  async load(
    config: WorkspaceIndexConfig,
    workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
  ): Promise<LoadedWorkspaceIndexSnapshot | undefined> {
    if (!this.filePath || !workspaceFolders?.length) {
      return undefined;
    }

    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as PersistedWorkspaceIndexSnapshot;

      if (!isPersistedWorkspaceIndexSnapshot(parsed) || !isMatchingConfig(parsed.config, config)) {
        return undefined;
      }

      const foldersByPath = new Map(
        workspaceFolders.map((folder) => [folder.uri.fsPath, folder] as const),
      );
      const snapshots = parsed.workspaceFolders
        .map((persistedFolder) => {
          const folder = foldersByPath.get(persistedFolder.workspaceFolderPath);

          if (!folder) {
            return undefined;
          }

          return createWorkspaceFolderIndexSnapshot(
            folder,
            restoreDirectoryNode(persistedFolder.root, folder.uri),
            persistedFolder.isTruncated,
          );
        })
        .filter(isDefined);

      if (!snapshots.length) {
        return undefined;
      }

      const signature = computeWorkspaceSnapshotSignature(snapshots);

      this.lastPersistedAt = parsed.persistedAt;
      this.lastPersistedSignature = signature;

      return {
        persistedAt: parsed.persistedAt,
        snapshots,
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError?.code !== "ENOENT") {
        this.log?.(`Failed to restore workspace index cache: ${toErrorMessage(error)}`);
      }

      return undefined;
    }
  }

  schedulePersist(
    config: WorkspaceIndexConfig,
    snapshots: readonly WorkspaceFolderIndexSnapshot[],
  ): void {
    if (!this.filePath) {
      return;
    }

    const signature = computeWorkspaceSnapshotSignature(snapshots);

    if (signature === this.lastPersistedSignature) {
      return;
    }

    this.pendingSignature = signature;
    this.pendingSnapshot = {
      version: CACHE_VERSION,
      persistedAt: Date.now(),
      config: {
        fileGlob: config.fileGlob,
        excludedDirectories: [...config.excludedDirectories],
        maxFileCount: config.maxFileCount,
      },
      workspaceFolders: snapshots.map(serializeWorkspaceFolderSnapshot),
    };

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushDelayMs);
  }

  async flush(): Promise<number | undefined> {
    this.flushPromise = this.flushPromise.then(() => this.flushNow());
    return this.flushPromise;
  }

  getPendingSignature(): string | undefined {
    return this.pendingSignature;
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.emitter.dispose();
    void this.flush();
  }

  private async flushNow(): Promise<number | undefined> {
    if (!this.filePath || !this.pendingSnapshot || !this.pendingSignature) {
      return this.lastPersistedAt;
    }

    const snapshot = this.pendingSnapshot;
    const signature = this.pendingSignature;

    this.pendingSnapshot = undefined;
    this.pendingSignature = undefined;

    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(snapshot), "utf8");
      this.lastPersistedAt = snapshot.persistedAt;
      this.lastPersistedSignature = signature;
      this.emitter.fire(this.lastPersistedAt);
      return this.lastPersistedAt;
    } catch (error) {
      this.log?.(`Failed to persist workspace index cache: ${toErrorMessage(error)}`);
      return this.lastPersistedAt;
    }
  }
}

function computeWorkspaceSnapshotSignature(
  snapshots: readonly WorkspaceFolderIndexSnapshot[],
): string {
  return snapshots
    .map(
      (snapshot) =>
        `${snapshot.workspaceFolderPath}:${snapshot.isTruncated ? 1 : 0}:${snapshot.root.fingerprint}`,
    )
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function serializeWorkspaceFolderSnapshot(
  snapshot: WorkspaceFolderIndexSnapshot,
): PersistedWorkspaceFolderSnapshot {
  return {
    workspaceFolderPath: snapshot.workspaceFolderPath,
    isTruncated: snapshot.isTruncated,
    root: serializeDirectoryNode(snapshot.root),
  };
}

function serializeDirectoryNode(directory: IndexedDirectoryNode): PersistedDirectoryNode {
  return {
    name: directory.name,
    relativePath: directory.relativePath,
    directories: [...directory.directories.values()].map(serializeDirectoryNode),
    files: [...directory.files.values()].map((file) => ({
      name: file.name,
      relativePath: file.relativePath,
    })),
  };
}

function restoreDirectoryNode(
  persistedDirectory: PersistedDirectoryNode,
  workspaceFolderUri: vscode.Uri,
): IndexedDirectoryNode {
  const directoryUri = persistedDirectory.relativePath
    ? vscode.Uri.joinPath(workspaceFolderUri, ...persistedDirectory.relativePath.split("/"))
    : workspaceFolderUri;
  const directories = new Map(
    persistedDirectory.directories.map((directory) => [
      directory.name,
      restoreDirectoryNode(directory, workspaceFolderUri),
    ]),
  );
  const files = new Map(
    persistedDirectory.files.map((file) => [
      file.name,
      createIndexedFileNode({
        name: file.name,
        relativePath: file.relativePath,
        uri: vscode.Uri.joinPath(workspaceFolderUri, ...file.relativePath.split("/")),
      }),
    ]),
  );

  return createIndexedDirectoryNode({
    name: persistedDirectory.name,
    relativePath: persistedDirectory.relativePath,
    uri: directoryUri,
    directories,
    files,
  });
}

function isPersistedWorkspaceIndexSnapshot(
  value: unknown,
): value is PersistedWorkspaceIndexSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<PersistedWorkspaceIndexSnapshot>;

  return (
    snapshot.version === CACHE_VERSION &&
    typeof snapshot.persistedAt === "number" &&
    isWorkspaceIndexConfig(snapshot.config) &&
    Array.isArray(snapshot.workspaceFolders)
  );
}

function isWorkspaceIndexConfig(value: unknown): value is WorkspaceIndexConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const config = value as Partial<WorkspaceIndexConfig>;

  return (
    typeof config.fileGlob === "string" &&
    Array.isArray(config.excludedDirectories) &&
    typeof config.maxFileCount === "number"
  );
}

function isMatchingConfig(left: WorkspaceIndexConfig, right: WorkspaceIndexConfig): boolean {
  return (
    left.fileGlob === right.fileGlob &&
    left.maxFileCount === right.maxFileCount &&
    left.excludedDirectories.length === right.excludedDirectories.length &&
    left.excludedDirectories.every((segment, index) => segment === right.excludedDirectories[index])
  );
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
