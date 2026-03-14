import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GitConfig } from "../config/schema";
import {
  buildAreaMetadata,
  buildAreaPrefixAllocations,
  collectMeaningfulAreaPrefixes,
  type AreaMetadata,
} from "./area-metadata";
import {
  GIT_TRACKED_INDEX_CACHE_VERSION,
  type GitStateValidation,
  shouldReusePersistedGitState,
} from "./git-tracked-index-cache";
import {
  mergeGitRefreshRequests,
  type GitRefreshKind,
  type GitRefreshRequest,
} from "./git-refresh-plan";
import {
  loadGitIndexStamp,
  loadGitStatusSnapshot,
  loadTrackedPaths,
  normalizeFsPath,
  resolveRepoRoot,
  runGit,
} from "./git-utils";
import { collectPackageRootDirectories } from "./package-root";
import type { GitTrackingState } from "./git-tracking-state";
import { normalizePath } from "./workspace-path";

const BRANCH_UNIQUE_WEIGHT = 0.85;
const WORKTREE_MODIFIED_WEIGHT = 1.1;
const WORKTREE_STAGED_WEIGHT = 1.3;
const WORKTREE_UNTRACKED_WEIGHT = 0.6;
const GIT_IGNORE_FILE_BASENAME = ".gitignore";

interface GitSessionOverlay {
  readonly areaWeights: ReadonlyMap<string, number>;
  readonly fileWeights: ReadonlyMap<string, number>;
}

interface WorkspaceGitSessionState {
  readonly areaMetadata: AreaMetadata;
  readonly repoRootPath: string;
  readonly sessionOverlay: GitSessionOverlay;
}

interface WorkspaceGitState {
  readonly areaMetadata?: AreaMetadata;
  readonly ignoredDirectoryPrefixes?: readonly string[];
  readonly ignoredPaths?: ReadonlySet<string>;
  readonly repoRootPath?: string;
  readonly snapshotSource?: "cache" | "live";
  readonly sessionOverlay?: GitSessionOverlay;
  readonly trackedPaths?: ReadonlySet<string>;
  readonly upstreamRef?: string;
  readonly validation?: GitStateValidation;
}

interface ResolvedWorkspaceGitState {
  readonly repoRelativePath: string;
  readonly state: WorkspaceGitState & {
    readonly repoRootPath: string;
  };
}

interface PersistedGitTrackedIndexSnapshot {
  readonly version: number;
  readonly workspaceStates: readonly (readonly [string, PersistedWorkspaceGitState])[];
}

interface PersistedGitSessionOverlay {
  readonly areaWeights: readonly [string, number][];
  readonly fileWeights: readonly [string, number][];
}

interface PersistedWorkspaceGitState {
  readonly ignoredDirectoryPrefixes: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly packageRootDirectories: readonly string[];
  readonly repoRootPath: string;
  readonly sessionOverlay: PersistedGitSessionOverlay;
  readonly trackedPaths: readonly string[];
  readonly upstreamRef?: string;
  readonly validation?: GitStateValidation;
}

interface GitTrackedIndexOptions {
  readonly log?: (message: string) => void;
  readonly persistenceFilePath?: string;
}

export class GitTrackedIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly states = new Map<string, WorkspaceGitState>();
  private readonly disposables: vscode.Disposable[] = [];
  private config: GitConfig;
  private refreshPromise = Promise.resolve();
  private persistPromise = Promise.resolve();
  private pendingRefreshRequest: GitRefreshRequest | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly log?: (message: string) => void;
  private readonly persistenceFilePath?: string;

  readonly onDidChange = this.emitter.event;

  constructor(config: GitConfig, options: GitTrackedIndexOptions = {}) {
    this.config = config;
    this.log = options.log;
    this.persistenceFilePath = options.persistenceFilePath;
    const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
    const indexWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");

    this.refreshPromise = this.initialize();

    this.disposables.push(
      headWatcher,
      indexWatcher,
      headWatcher.onDidCreate((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      headWatcher.onDidChange((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      headWatcher.onDidDelete((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      indexWatcher.onDidCreate((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      indexWatcher.onDidChange((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      indexWatcher.onDidDelete((uri) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths([uri]),
        });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRefresh({ kind: "full" });
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== "file") {
          return;
        }

        this.debounceRefresh({
          kind: shouldFullyRefreshSavedDocument(document.uri) ? "full" : "overlay",
          workspaceFolderPaths: collectWorkspaceFolderPaths([document.uri]),
        });
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths(event.files),
        });
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths(event.files),
        });
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        this.debounceRefresh({
          kind: "full",
          workspaceFolderPaths: collectWorkspaceFolderPaths(
            event.files.flatMap(({ oldUri, newUri }) => [oldUri, newUri]),
          ),
        });
      }),
    );
  }

  async ready(): Promise<void> {
    await this.refreshPromise;
  }

  getSessionState(uri: vscode.Uri): WorkspaceGitSessionState | undefined {
    const resolution = resolveUriState(this.states, uri);

    if (!resolution?.state.areaMetadata || !resolution.state.sessionOverlay) {
      return undefined;
    }

    return {
      areaMetadata: resolution.state.areaMetadata,
      repoRootPath: resolution.state.repoRootPath,
      sessionOverlay: resolution.state.sessionOverlay,
    };
  }

  getTrackingState(uri: vscode.Uri): GitTrackingState {
    const resolution = resolveUriState(this.states, uri);

    if (!resolution?.state.trackedPaths) {
      return "unknown";
    }

    if (resolution.state.trackedPaths.has(resolution.repoRelativePath)) {
      return "tracked";
    }

    if (
      resolution.state.ignoredPaths?.has(resolution.repoRelativePath) ||
      resolution.state.ignoredDirectoryPrefixes?.some((prefix) =>
        resolution.repoRelativePath.startsWith(prefix),
      )
    ) {
      return "ignored";
    }

    return "untracked";
  }

  updateConfig(config: GitConfig): void {
    this.config = config;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    void this.persistPromise;

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.emitter.dispose();
  }

  private async initialize(): Promise<void> {
    const restoredSnapshot = await this.restoreSnapshotFromCache();

    if (restoredSnapshot) {
      this.emitter.fire();
    }

    await this.refresh({
      kind: restoredSnapshot ? "overlay" : "full",
    });
  }

  private debounceRefresh(request: GitRefreshRequest): void {
    this.pendingRefreshRequest = mergeGitRefreshRequests(this.pendingRefreshRequest, request);

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const pendingRequest = this.pendingRefreshRequest;

      this.pendingRefreshRequest = undefined;

      if (pendingRequest) {
        this.scheduleRefresh(pendingRequest);
      }
    }, this.config.refreshDebounceMs);
  }

  private scheduleRefresh(request: GitRefreshRequest): void {
    this.refreshPromise = this.refreshPromise.then(() => this.refresh(request));
  }

  private async refresh(request: GitRefreshRequest): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const targetFolders = selectRefreshFolders(folders, request.workspaceFolderPaths);
    const nextStates =
      request.workspaceFolderPaths === undefined
        ? new Map<string, WorkspaceGitState>()
        : new Map(this.states);
    const refreshedStates = await loadWorkspaceGitStates(
      targetFolders,
      request.kind,
      this.states,
      this.log,
    );

    if (request.workspaceFolderPaths === undefined) {
      nextStates.clear();
    } else {
      for (const folderPath of request.workspaceFolderPaths) {
        if (!folders.some((folder) => folder.uri.fsPath === folderPath)) {
          nextStates.delete(folderPath);
        }
      }
    }

    for (const [folderPath, state] of refreshedStates.entries()) {
      nextStates.set(folderPath, state);
    }

    this.states.clear();

    for (const [folderPath, state] of nextStates.entries()) {
      this.states.set(folderPath, state);
    }

    this.schedulePersist();
    this.emitter.fire();
  }

  private async restoreSnapshotFromCache(): Promise<boolean> {
    if (!this.persistenceFilePath) {
      return false;
    }

    try {
      const snapshot = JSON.parse(
        await fs.readFile(this.persistenceFilePath, "utf8"),
      ) as PersistedGitTrackedIndexSnapshot;

      if (snapshot.version !== GIT_TRACKED_INDEX_CACHE_VERSION) {
        return false;
      }

      const activeWorkspaceFolderPaths = new Set(
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      );
      let restoredCount = 0;

      this.states.clear();

      for (const [workspaceFolderPath, persistedState] of snapshot.workspaceStates) {
        if (!activeWorkspaceFolderPaths.has(workspaceFolderPath)) {
          continue;
        }

        const restoredState = restoreWorkspaceGitState(persistedState);

        if (!restoredState) {
          continue;
        }

        this.states.set(workspaceFolderPath, restoredState);
        restoredCount += 1;
      }

      if (restoredCount > 0) {
        this.log?.(`Restored cached Git state for ${restoredCount} workspace folder(s).`);
      }

      return restoredCount > 0;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError?.code === "ENOENT") {
        return false;
      }

      this.log?.(`Failed to restore Git state cache: ${toErrorMessage(error)}`);
      return false;
    }
  }

  private schedulePersist(): void {
    this.persistPromise = this.persistPromise.then(
      () => this.persistSnapshotToCache(),
      () => this.persistSnapshotToCache(),
    );
  }

  private async persistSnapshotToCache(): Promise<void> {
    if (!this.persistenceFilePath) {
      return;
    }

    const workspaceStates = [...this.states.entries()].flatMap(([workspaceFolderPath, state]) => {
      const persistedState = toPersistedWorkspaceGitState(state);

      return persistedState ? ([[workspaceFolderPath, persistedState]] as const) : [];
    });
    const snapshot: PersistedGitTrackedIndexSnapshot = {
      version: GIT_TRACKED_INDEX_CACHE_VERSION,
      workspaceStates,
    };
    const temporaryFilePath = `${this.persistenceFilePath}.${process.pid}.${Date.now()}.tmp`;

    await fs.mkdir(path.dirname(this.persistenceFilePath), { recursive: true });
    await fs.writeFile(temporaryFilePath, JSON.stringify(snapshot), "utf8");
    await fs.rename(temporaryFilePath, this.persistenceFilePath);
  }
}

export function scoreGitSessionOverlay(
  overlay: GitSessionOverlay,
  filePath: string,
  areaMetadata: AreaMetadata,
): number {
  let score = overlay.fileWeights.get(filePath) ?? 0;

  for (const allocation of buildAreaPrefixAllocations(
    collectMeaningfulAreaPrefixes(filePath, areaMetadata.packageRootDirectories),
    areaMetadata,
  )) {
    score += allocation.weight * (overlay.areaWeights.get(allocation.key) ?? 0);
  }

  return score;
}

async function loadWorkspaceGitStates(
  folders: readonly vscode.WorkspaceFolder[],
  kind: GitRefreshKind,
  previousStates: ReadonlyMap<string, WorkspaceGitState>,
  log?: (message: string) => void,
): Promise<ReadonlyMap<string, WorkspaceGitState>> {
  const states = new Map<string, WorkspaceGitState>();
  const resolvedFolders = await Promise.all(
    folders.map((folder) =>
      resolveWorkspaceFolderRepoRoot(folder, kind === "overlay" ? previousStates : undefined),
    ),
  );
  const folderNamesByRepoRoot = new Map<string, string[]>();
  const previousStateByRepoRoot = new Map<string, WorkspaceGitState>();

  for (const resolvedFolder of resolvedFolders) {
    if (!resolvedFolder.repoRootPath) {
      states.set(resolvedFolder.folder.uri.fsPath, {});
      continue;
    }

    const folderNames = folderNamesByRepoRoot.get(resolvedFolder.repoRootPath) ?? [];

    folderNames.push(resolvedFolder.folder.name);
    folderNamesByRepoRoot.set(resolvedFolder.repoRootPath, folderNames);

    const previousState = previousStates.get(resolvedFolder.folder.uri.fsPath);

    if (previousState && !previousStateByRepoRoot.has(resolvedFolder.repoRootPath)) {
      previousStateByRepoRoot.set(resolvedFolder.repoRootPath, previousState);
    }
  }

  const repoStateEntries = await Promise.all(
    [...folderNamesByRepoRoot.entries()].map(
      async ([repoRootPath, folderNames]) =>
        [
          repoRootPath,
          await loadRepoGitState(
            repoRootPath,
            kind,
            previousStateByRepoRoot.get(repoRootPath),
            folderNames,
            log,
          ),
        ] as const,
    ),
  );
  const repoStateByRepoRoot = new Map(repoStateEntries);

  for (const resolvedFolder of resolvedFolders) {
    if (!resolvedFolder.repoRootPath) {
      continue;
    }

    states.set(
      resolvedFolder.folder.uri.fsPath,
      repoStateByRepoRoot.get(resolvedFolder.repoRootPath) ?? {},
    );
  }

  return states;
}

async function resolveWorkspaceFolderRepoRoot(
  folder: vscode.WorkspaceFolder,
  previousStates?: ReadonlyMap<string, WorkspaceGitState>,
): Promise<{ readonly folder: vscode.WorkspaceFolder; readonly repoRootPath?: string }> {
  if (folder.uri.scheme !== "file") {
    return { folder };
  }

  const cachedRepoRootPath = previousStates?.get(folder.uri.fsPath)?.repoRootPath;

  if (cachedRepoRootPath) {
    return {
      folder,
      repoRootPath: cachedRepoRootPath,
    };
  }

  try {
    return {
      folder,
      repoRootPath: await resolveRepoRoot(folder.uri.fsPath),
    };
  } catch {
    return { folder };
  }
}

async function loadRepoGitState(
  repoRootPath: string,
  kind: GitRefreshKind,
  previousState: WorkspaceGitState | undefined,
  folderNames: readonly string[],
  log?: (message: string) => void,
): Promise<WorkspaceGitState> {
  try {
    const canUseOverlayBase =
      kind === "overlay" && isOverlayCapableWorkspaceGitState(previousState, repoRootPath);
    const preloadedStatusSnapshot = canUseOverlayBase
      ? await loadGitStatusSnapshot(repoRootPath)
      : undefined;

    if (canUseOverlayBase && preloadedStatusSnapshot) {
      const currentValidation: GitStateValidation = {
        headCommit: preloadedStatusSnapshot.headCommit,
        indexStamp:
          previousState.snapshotSource === "cache"
            ? await loadGitIndexStamp(repoRootPath)
            : previousState.validation?.indexStamp,
      };

      if (
        previousState.snapshotSource !== "cache" ||
        shouldReusePersistedGitState(previousState.validation, currentValidation)
      ) {
        const branchPaths = await loadBranchUniquePaths(
          repoRootPath,
          preloadedStatusSnapshot.upstreamRef,
        );
        const sessionOverlay = createSessionOverlay(
          preloadedStatusSnapshot.stagedPaths,
          preloadedStatusSnapshot.modifiedPaths,
          preloadedStatusSnapshot.untrackedPaths,
          branchPaths,
          previousState.areaMetadata,
        );

        log?.(`Refreshed Git session overlay for ${folderNames.join(", ")}.`);

        return {
          ...previousState,
          ignoredPaths: preloadedStatusSnapshot.ignoredPaths,
          ignoredDirectoryPrefixes: preloadedStatusSnapshot.ignoredDirectoryPrefixes,
          repoRootPath,
          sessionOverlay,
          snapshotSource: "live",
          upstreamRef: preloadedStatusSnapshot.upstreamRef,
          validation: currentValidation,
        };
      }

      log?.(`Cached Git state invalidated for ${folderNames.join(", ")}; reloading tracked files.`);
    }

    const statusSnapshot = preloadedStatusSnapshot ?? (await loadGitStatusSnapshot(repoRootPath));
    const [trackedPaths, branchPaths, indexStamp] = await Promise.all([
      loadTrackedPaths(repoRootPath),
      loadBranchUniquePaths(repoRootPath, statusSnapshot.upstreamRef),
      loadGitIndexStamp(repoRootPath),
    ]);
    const packageRootDirectories = collectPackageRootDirectories([...trackedPaths]);
    const areaMetadata = buildAreaMetadata([...trackedPaths], packageRootDirectories);
    const sessionOverlay = createSessionOverlay(
      statusSnapshot.stagedPaths,
      statusSnapshot.modifiedPaths,
      statusSnapshot.untrackedPaths,
      branchPaths,
      areaMetadata,
    );

    log?.(`Loaded ${trackedPaths.size} tracked Git files for ${folderNames.join(", ")}.`);

    return {
      areaMetadata,
      ignoredPaths: statusSnapshot.ignoredPaths,
      ignoredDirectoryPrefixes: statusSnapshot.ignoredDirectoryPrefixes,
      repoRootPath,
      snapshotSource: "live",
      sessionOverlay,
      trackedPaths,
      upstreamRef: statusSnapshot.upstreamRef,
      validation: {
        headCommit: statusSnapshot.headCommit,
        indexStamp,
      },
    };
  } catch {
    return {};
  }
}

function isOverlayCapableWorkspaceGitState(
  state: WorkspaceGitState | undefined,
  repoRootPath: string,
): state is WorkspaceGitState & {
  readonly areaMetadata: AreaMetadata;
  readonly ignoredDirectoryPrefixes: readonly string[];
  readonly ignoredPaths: ReadonlySet<string>;
  readonly repoRootPath: string;
  readonly sessionOverlay: GitSessionOverlay;
  readonly trackedPaths: ReadonlySet<string>;
} {
  return Boolean(
    state?.repoRootPath === repoRootPath &&
    state.areaMetadata &&
    state.trackedPaths &&
    state.ignoredPaths &&
    state.ignoredDirectoryPrefixes &&
    state.sessionOverlay,
  );
}

function toPersistedWorkspaceGitState(
  state: WorkspaceGitState,
): PersistedWorkspaceGitState | undefined {
  if (
    !state.repoRootPath ||
    !state.areaMetadata ||
    !state.sessionOverlay ||
    !state.trackedPaths ||
    !state.ignoredPaths ||
    !state.ignoredDirectoryPrefixes
  ) {
    return undefined;
  }

  return {
    ignoredDirectoryPrefixes: state.ignoredDirectoryPrefixes,
    ignoredPaths: [...state.ignoredPaths],
    packageRootDirectories: [...state.areaMetadata.packageRootDirectories],
    repoRootPath: state.repoRootPath,
    sessionOverlay: {
      areaWeights: [...state.sessionOverlay.areaWeights.entries()],
      fileWeights: [...state.sessionOverlay.fileWeights.entries()],
    },
    trackedPaths: [...state.trackedPaths],
    upstreamRef: state.upstreamRef,
    validation: state.validation,
  };
}

function restoreWorkspaceGitState(
  persistedState: PersistedWorkspaceGitState,
): WorkspaceGitState | undefined {
  if (
    !persistedState.repoRootPath ||
    !persistedState.packageRootDirectories ||
    !persistedState.sessionOverlay ||
    !persistedState.trackedPaths ||
    !persistedState.ignoredPaths ||
    !persistedState.ignoredDirectoryPrefixes
  ) {
    return undefined;
  }

  return {
    areaMetadata: buildAreaMetadata(
      persistedState.trackedPaths,
      new Set(persistedState.packageRootDirectories),
    ),
    ignoredDirectoryPrefixes: persistedState.ignoredDirectoryPrefixes,
    ignoredPaths: new Set(persistedState.ignoredPaths),
    repoRootPath: persistedState.repoRootPath,
    snapshotSource: "cache",
    sessionOverlay: {
      areaWeights: new Map(persistedState.sessionOverlay.areaWeights),
      fileWeights: new Map(persistedState.sessionOverlay.fileWeights),
    },
    trackedPaths: new Set(persistedState.trackedPaths),
    upstreamRef: persistedState.upstreamRef,
    validation: persistedState.validation,
  };
}

function createSessionOverlay(
  stagedPaths: readonly string[],
  modifiedPaths: readonly string[],
  untrackedPaths: readonly string[],
  branchPaths: readonly string[],
  areaMetadata: AreaMetadata,
): GitSessionOverlay {
  const fileWeights = new Map<string, number>();

  addPathWeights(fileWeights, branchPaths, BRANCH_UNIQUE_WEIGHT);
  addPathWeights(fileWeights, modifiedPaths, WORKTREE_MODIFIED_WEIGHT);
  addPathWeights(fileWeights, stagedPaths, WORKTREE_STAGED_WEIGHT);
  addPathWeights(fileWeights, untrackedPaths, WORKTREE_UNTRACKED_WEIGHT);

  const areaWeights = new Map<string, number>();

  for (const [filePath, weight] of fileWeights.entries()) {
    for (const allocation of buildAreaPrefixAllocations(
      collectMeaningfulAreaPrefixes(filePath, areaMetadata.packageRootDirectories),
      areaMetadata,
    )) {
      areaWeights.set(
        allocation.key,
        (areaWeights.get(allocation.key) ?? 0) + weight * allocation.weight,
      );
    }
  }

  return {
    areaWeights,
    fileWeights,
  };
}

async function loadBranchUniquePaths(
  repoRootPath: string,
  upstreamRef: string | undefined,
): Promise<readonly string[]> {
  if (!upstreamRef) {
    return [];
  }

  try {
    return loadNulSeparatedPaths(
      await runGit(repoRootPath, [
        "diff",
        "--name-only",
        "-z",
        "-M",
        `${upstreamRef}...HEAD`,
        "--",
      ]),
    );
  } catch {
    return [];
  }
}

function loadNulSeparatedPaths(stdout: string): readonly string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of stdout.split("\u0000")) {
    const normalizedEntry = normalizePath(entry.trim());

    if (!normalizedEntry || seenPaths.has(normalizedEntry)) {
      continue;
    }

    seenPaths.add(normalizedEntry);
    paths.push(normalizedEntry);
  }

  return paths;
}

function addPathWeights(
  targetWeights: Map<string, number>,
  paths: readonly string[],
  weight: number,
): void {
  if (weight <= 0) {
    return;
  }

  for (const filePath of paths) {
    targetWeights.set(filePath, (targetWeights.get(filePath) ?? 0) + weight);
  }
}

function resolveUriState(
  states: ReadonlyMap<string, WorkspaceGitState>,
  uri: vscode.Uri,
): ResolvedWorkspaceGitState | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

  if (!workspaceFolder) {
    return undefined;
  }

  const state = states.get(workspaceFolder.uri.fsPath);

  if (!state?.repoRootPath) {
    return undefined;
  }

  const normalizedFilePath = normalizeFsPath(uri.fsPath);
  const normalizedRepoRootPath = normalizeFsPath(state.repoRootPath);

  if (
    normalizedFilePath !== normalizedRepoRootPath &&
    !normalizedFilePath.startsWith(`${normalizedRepoRootPath}/`)
  ) {
    return undefined;
  }

  return {
    repoRelativePath: normalizePath(path.relative(state.repoRootPath, uri.fsPath)),
    state: state as WorkspaceGitState & {
      readonly repoRootPath: string;
    },
  };
}

function selectRefreshFolders(
  folders: readonly vscode.WorkspaceFolder[],
  workspaceFolderPaths: readonly string[] | undefined,
): readonly vscode.WorkspaceFolder[] {
  if (!workspaceFolderPaths) {
    return folders;
  }

  const targetPaths = new Set(workspaceFolderPaths);

  return folders.filter((folder) => targetPaths.has(folder.uri.fsPath));
}

function collectWorkspaceFolderPaths(uris: readonly vscode.Uri[]): readonly string[] | undefined {
  const folderPaths = new Set<string>();

  for (const uri of uris) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

    if (workspaceFolder) {
      folderPaths.add(workspaceFolder.uri.fsPath);
    }
  }

  return folderPaths.size > 0 ? [...folderPaths] : undefined;
}

function shouldFullyRefreshSavedDocument(uri: vscode.Uri): boolean {
  return path.posix.basename(normalizePath(uri.fsPath)) === GIT_IGNORE_FILE_BASENAME;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
