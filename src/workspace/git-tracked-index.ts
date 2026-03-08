import * as path from "node:path";
import * as vscode from "vscode";
import type { GitConfig } from "../config/schema";
import type { GitTrackingState } from "./git-tracking-state";
import { loadTrackedPaths, normalizeFsPath, resolveRepoRoot, runGit } from "./git-utils";
import { normalizePath } from "./workspace-path";

interface WorkspaceGitState {
  readonly repoRootPath?: string;
  readonly trackedPaths?: ReadonlySet<string>;
  readonly ignoredPaths?: ReadonlySet<string>;
  readonly ignoredDirectoryPrefixes?: readonly string[];
}

export class GitTrackedIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly states = new Map<string, WorkspaceGitState>();
  private readonly disposables: vscode.Disposable[] = [];
  private config: GitConfig;
  private refreshPromise = Promise.resolve();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(
    config: GitConfig,
    private readonly log?: (message: string) => void,
  ) {
    this.config = config;
    this.scheduleRefresh();

    const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
    const indexWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
    const triggerRefresh = (): void => {
      this.debounceRefresh();
    };

    this.disposables.push(
      headWatcher,
      indexWatcher,
      headWatcher.onDidCreate(triggerRefresh),
      headWatcher.onDidChange(triggerRefresh),
      headWatcher.onDidDelete(triggerRefresh),
      indexWatcher.onDidCreate(triggerRefresh),
      indexWatcher.onDidChange(triggerRefresh),
      indexWatcher.onDidDelete(triggerRefresh),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRefresh();
      }),
    );
  }

  async ready(): Promise<void> {
    await this.refreshPromise;
  }

  getTrackingState(uri: vscode.Uri): GitTrackingState {
    if (uri.scheme !== "file") {
      return "unknown";
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

    if (!workspaceFolder) {
      return "unknown";
    }

    const state = this.states.get(workspaceFolder.uri.fsPath);

    if (!state?.repoRootPath || !state.trackedPaths) {
      return "unknown";
    }

    const normalizedFilePath = normalizeFsPath(uri.fsPath);
    const normalizedRepoRootPath = normalizeFsPath(state.repoRootPath);

    if (
      normalizedFilePath !== normalizedRepoRootPath &&
      !normalizedFilePath.startsWith(`${normalizedRepoRootPath}/`)
    ) {
      return "unknown";
    }

    const repoRelativePath = normalizePath(path.relative(state.repoRootPath, uri.fsPath));

    if (state.trackedPaths.has(repoRelativePath)) {
      return "tracked";
    }

    if (
      state.ignoredPaths?.has(repoRelativePath) ||
      state.ignoredDirectoryPrefixes?.some((prefix) => repoRelativePath.startsWith(prefix))
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

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.emitter.dispose();
  }

  private debounceRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.scheduleRefresh();
    }, this.config.refreshDebounceMs);
  }

  private scheduleRefresh(): void {
    this.refreshPromise = this.refreshPromise.then(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const nextStates = new Map<string, WorkspaceGitState>();

    await Promise.all(
      folders.map(async (folder) => {
        const state = await loadWorkspaceGitState(folder, this.log);
        nextStates.set(folder.uri.fsPath, state);
      }),
    );

    this.states.clear();

    for (const [folderPath, state] of nextStates.entries()) {
      this.states.set(folderPath, state);
    }

    this.emitter.fire();
  }
}

async function loadWorkspaceGitState(
  folder: vscode.WorkspaceFolder,
  log?: (message: string) => void,
): Promise<WorkspaceGitState> {
  if (folder.uri.scheme !== "file") {
    return {};
  }

  try {
    const repoRootPath = await resolveRepoRoot(folder.uri.fsPath);
    const trackedPaths = await loadTrackedPaths(repoRootPath);
    const { ignoredPaths, ignoredDirectoryPrefixes } = await loadIgnoredPaths(repoRootPath);

    log?.(`Loaded ${trackedPaths.size} tracked Git files for ${folder.name}.`);

    return {
      repoRootPath,
      trackedPaths,
      ignoredPaths,
      ignoredDirectoryPrefixes,
    };
  } catch {
    return {};
  }
}

async function loadIgnoredPaths(
  repoRootPath: string,
): Promise<{ ignoredPaths: ReadonlySet<string>; ignoredDirectoryPrefixes: readonly string[] }> {
  const stdout = await runGit(repoRootPath, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
  ]);
  const ignoredPaths = new Set<string>();
  const ignoredDirectoryPrefixes: string[] = [];

  for (const entry of stdout.split("\u0000")) {
    if (!entry) {
      continue;
    }

    const normalizedEntry = normalizePath(entry);

    if (normalizedEntry.endsWith("/")) {
      ignoredDirectoryPrefixes.push(normalizedEntry);
      continue;
    }

    ignoredPaths.add(normalizedEntry);
  }

  return {
    ignoredPaths,
    ignoredDirectoryPrefixes,
  };
}
