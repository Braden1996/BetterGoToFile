import * as path from "node:path";
import * as vscode from "vscode";
import type { GitConfig } from "../config/schema";
import { collectMeaningfulAreaPrefixes } from "./contributor-relationship-model";
import { loadTrackedPaths, normalizeFsPath, resolveRepoRoot, runGit } from "./git-utils";
import { collectPackageRootDirectories } from "./package-root";
import type { GitTrackingState } from "./git-tracking-state";
import { normalizePath } from "./workspace-path";

const BRANCH_UNIQUE_WEIGHT = 0.85;
const WORKTREE_MODIFIED_WEIGHT = 1.1;
const WORKTREE_STAGED_WEIGHT = 1.3;
const WORKTREE_UNTRACKED_WEIGHT = 0.6;

interface GitSessionOverlay {
  readonly areaWeights: ReadonlyMap<string, number>;
  readonly fileWeights: ReadonlyMap<string, number>;
}

interface WorkspaceGitSessionState {
  readonly packageRootDirectories: ReadonlySet<string>;
  readonly repoRootPath: string;
  readonly sessionOverlay: GitSessionOverlay;
}

interface WorkspaceGitState {
  readonly ignoredDirectoryPrefixes?: readonly string[];
  readonly ignoredPaths?: ReadonlySet<string>;
  readonly packageRootDirectories?: ReadonlySet<string>;
  readonly repoRootPath?: string;
  readonly sessionOverlay?: GitSessionOverlay;
  readonly trackedPaths?: ReadonlySet<string>;
}

interface ResolvedWorkspaceGitState {
  readonly repoRelativePath: string;
  readonly state: WorkspaceGitState & {
    readonly repoRootPath: string;
  };
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
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file") {
          triggerRefresh();
        }
      }),
      vscode.workspace.onDidCreateFiles(triggerRefresh),
      vscode.workspace.onDidDeleteFiles(triggerRefresh),
      vscode.workspace.onDidRenameFiles(triggerRefresh),
    );
  }

  async ready(): Promise<void> {
    await this.refreshPromise;
  }

  getSessionState(uri: vscode.Uri): WorkspaceGitSessionState | undefined {
    const resolution = resolveUriState(this.states, uri);

    if (!resolution?.state.packageRootDirectories || !resolution.state.sessionOverlay) {
      return undefined;
    }

    return {
      packageRootDirectories: resolution.state.packageRootDirectories,
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

export function scoreGitSessionOverlay(
  overlay: GitSessionOverlay,
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): number {
  let score = overlay.fileWeights.get(filePath) ?? 0;

  for (const allocation of buildAreaPrefixAllocations(
    collectMeaningfulAreaPrefixes(filePath, packageRootDirectories),
  )) {
    score += allocation.weight * (overlay.areaWeights.get(allocation.key) ?? 0);
  }

  return score;
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
    const packageRootDirectories = collectPackageRootDirectories([...trackedPaths]);
    const [{ ignoredPaths, ignoredDirectoryPrefixes }, sessionOverlay] = await Promise.all([
      loadIgnoredPaths(repoRootPath),
      loadSessionOverlay(repoRootPath, packageRootDirectories),
    ]);

    log?.(`Loaded ${trackedPaths.size} tracked Git files for ${folder.name}.`);

    return {
      ignoredPaths,
      ignoredDirectoryPrefixes,
      packageRootDirectories,
      repoRootPath,
      sessionOverlay,
      trackedPaths,
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

  for (const entry of loadNulSeparatedPaths(stdout)) {
    if (entry.endsWith("/")) {
      ignoredDirectoryPrefixes.push(entry);
      continue;
    }

    ignoredPaths.add(entry);
  }

  return {
    ignoredPaths,
    ignoredDirectoryPrefixes,
  };
}

async function loadSessionOverlay(
  repoRootPath: string,
  packageRootDirectories: ReadonlySet<string>,
): Promise<GitSessionOverlay> {
  const [stagedPaths, modifiedPaths, untrackedPaths, branchPaths] = await Promise.all([
    loadDiffPaths(repoRootPath, ["diff", "--name-only", "-z", "-M", "--cached", "--"]),
    loadDiffPaths(repoRootPath, ["diff", "--name-only", "-z", "-M", "--"]),
    loadUntrackedPaths(repoRootPath),
    loadBranchUniquePaths(repoRootPath),
  ]);
  const fileWeights = new Map<string, number>();

  addPathWeights(fileWeights, branchPaths, BRANCH_UNIQUE_WEIGHT);
  addPathWeights(fileWeights, modifiedPaths, WORKTREE_MODIFIED_WEIGHT);
  addPathWeights(fileWeights, stagedPaths, WORKTREE_STAGED_WEIGHT);
  addPathWeights(fileWeights, untrackedPaths, WORKTREE_UNTRACKED_WEIGHT);

  const areaWeights = new Map<string, number>();

  for (const [filePath, weight] of fileWeights.entries()) {
    for (const allocation of buildAreaPrefixAllocations(
      collectMeaningfulAreaPrefixes(filePath, packageRootDirectories),
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

async function loadDiffPaths(
  repoRootPath: string,
  args: readonly string[],
): Promise<readonly string[]> {
  return loadNulSeparatedPaths(await runGit(repoRootPath, args));
}

async function loadUntrackedPaths(repoRootPath: string): Promise<readonly string[]> {
  return loadNulSeparatedPaths(
    await runGit(repoRootPath, ["ls-files", "-z", "--others", "--exclude-standard"]),
  );
}

async function loadBranchUniquePaths(repoRootPath: string): Promise<readonly string[]> {
  const upstreamRef = await loadUpstreamRef(repoRootPath);

  if (!upstreamRef) {
    return [];
  }

  try {
    const mergeBase = (await runGit(repoRootPath, ["merge-base", "HEAD", upstreamRef])).trim();

    if (!mergeBase) {
      return [];
    }

    return loadDiffPaths(repoRootPath, [
      "diff",
      "--name-only",
      "-z",
      "-M",
      `${mergeBase}..HEAD`,
      "--",
    ]);
  } catch {
    return [];
  }
}

async function loadUpstreamRef(repoRootPath: string): Promise<string | undefined> {
  try {
    const upstreamRef = (
      await runGit(repoRootPath, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ])
    ).trim();

    return upstreamRef || undefined;
  } catch {
    return undefined;
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

function buildAreaPrefixAllocations(
  areaPrefixes: readonly string[],
): readonly { key: string; weight: number }[] {
  if (!areaPrefixes.length) {
    return [];
  }

  const totalWeight = (areaPrefixes.length * (areaPrefixes.length + 1)) / 2;

  return areaPrefixes.map((areaPrefix, index) => ({
    key: areaPrefix,
    weight: (index + 1) / totalWeight,
  }));
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
