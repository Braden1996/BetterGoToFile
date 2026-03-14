import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION,
  shouldRestoreCachedContributorState,
} from "./contributor-relationship-cache";
import {
  buildContributorSearchProfile,
  buildContributorRelationshipGraph,
  createContributorIdentity,
  formatContributorIdentity,
  rankContributorRelationships,
  type ContributorSearchProfile,
  type ContributorIdentity,
  type ContributorRelationshipGraph,
  type ContributorRelationship,
  type ContributorSelector,
  type ContributorSummary,
  type ContributorTouch,
  type ContributorTouchedFile,
} from "./contributor-relationship-model";
import { loadGitIndexStamp, loadTrackedPaths, resolveRepoRoot, runGit } from "./git-utils";
import { normalizePath } from "./workspace-path";

const COMMIT_SEPARATOR = "\u001e";
const CACHE_VERSION = CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION;
const CONTRIBUTOR_HISTORY_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_TOUCHED_PATHS: readonly string[] = [];
const FIELD_SEPARATOR = "\u001f";
const MAX_TOP_CONTRIBUTORS = 8;

export type WorkspaceContributorRelationshipStatus =
  | "ready"
  | "not-git"
  | "no-history"
  | "no-current-contributor";

export interface WorkspaceContributorRelationshipSnapshot {
  readonly workspaceFolderName: string;
  readonly workspaceFolderPath: string;
  readonly repoRootPath?: string;
  readonly status: WorkspaceContributorRelationshipStatus;
  readonly configuredContributor?: ContributorSelector;
  readonly currentContributor?: ContributorIdentity;
  readonly currentContributorFileCount: number;
  readonly currentContributorCommitCount: number;
  readonly currentContributorAreaFastWeight: number;
  readonly currentContributorAreaSlowWeight: number;
  readonly currentContributorFileFastWeight: number;
  readonly currentContributorFileSlowWeight: number;
  readonly trackedFileCount: number;
  readonly contributorCount: number;
  readonly contributors: readonly ContributorSummary[];
  readonly relationships: readonly ContributorRelationship[];
  readonly topContributors: readonly ContributorSummary[];
}

interface WorkspaceContributorSearchState {
  readonly profile: ContributorSearchProfile;
  readonly repoRootPath: string;
  readonly workspaceFolderPath: string;
}

interface CachedContributorSearchState {
  readonly contributorKey: string;
  readonly areaSubtreeFileCounts: readonly [string, number][];
  readonly currentPathToLineageKey: readonly [string, string][];
  readonly fileWeights: readonly [string, number][];
  readonly ownerShares: readonly [string, number][];
  readonly packageRootDirectories: readonly string[];
  readonly teamAreaWeights: readonly [string, number][];
  readonly teamFileWeights: readonly [string, number][];
  readonly teammateCount: number;
}

interface CachedWorkspaceContributorRelationshipState {
  readonly configuredContributor?: ContributorSelector;
  readonly headCommit: string;
  readonly indexStamp?: string;
  readonly searchState?: CachedContributorSearchState;
  readonly snapshot: WorkspaceContributorRelationshipSnapshot;
  readonly version: number;
}

interface RepoContributorRelationshipState {
  readonly graph?: ContributorRelationshipGraph;
  readonly searchState?: WorkspaceContributorSearchState;
  readonly snapshot: WorkspaceContributorRelationshipSnapshot;
}

interface WorkspaceContributorRelationshipState {
  readonly searchState?: WorkspaceContributorSearchState;
  readonly snapshot: WorkspaceContributorRelationshipSnapshot;
}

export class ContributorRelationshipIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly snapshots = new Map<string, Promise<WorkspaceContributorRelationshipState>>();
  private readonly repoSnapshots = new Map<string, Promise<RepoContributorRelationshipState>>();
  private readonly states = new Map<string, WorkspaceContributorRelationshipState>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly cacheDirectoryPath?: string,
    private readonly log?: (message: string) => void,
  ) {
    const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
    const refsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/refs/**");
    const packedRefsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/packed-refs");
    const invalidate = (): void => {
      this.snapshots.clear();
      this.repoSnapshots.clear();
      this.states.clear();
      this.emitter.fire();
      this.debounceWarmSnapshots();
    };

    this.disposables.push(
      this.emitter,
      headWatcher,
      refsWatcher,
      packedRefsWatcher,
      headWatcher.onDidCreate(invalidate),
      headWatcher.onDidChange(invalidate),
      headWatcher.onDidDelete(invalidate),
      refsWatcher.onDidCreate(invalidate),
      refsWatcher.onDidChange(invalidate),
      refsWatcher.onDidDelete(invalidate),
      packedRefsWatcher.onDidCreate(invalidate),
      packedRefsWatcher.onDidChange(invalidate),
      packedRefsWatcher.onDidDelete(invalidate),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.snapshots.clear();
        this.repoSnapshots.clear();
        this.states.clear();
        this.emitter.fire();
        this.scheduleWarmSnapshots();
      }),
    );

    this.scheduleWarmSnapshots();
  }

  async ready(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    await Promise.allSettled(folders.map(async (folder) => this.getState(folder)));
  }

  async inspectWorkspaceFolders(): Promise<readonly WorkspaceContributorRelationshipSnapshot[]> {
    return this.inspectWorkspaceFoldersForSelection();
  }

  async inspectWorkspaceFoldersForSelection(
    selectedContributorKeysByWorkspaceFolderPath: ReadonlyMap<string, string> = new Map(),
  ): Promise<readonly WorkspaceContributorRelationshipSnapshot[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    return Promise.all(
      folders.map(async (folder) => {
        const selectedContributorKey = selectedContributorKeysByWorkspaceFolderPath.get(
          folder.uri.fsPath,
        );

        return this.inspectWorkspaceFolder(folder, selectedContributorKey);
      }),
    );
  }

  getSearchState(workspaceFolderPath: string): WorkspaceContributorSearchState | undefined {
    return this.states.get(workspaceFolderPath)?.searchState;
  }

  getLoadedSnapshots(): readonly WorkspaceContributorRelationshipSnapshot[] {
    const folders = vscode.workspace.workspaceFolders ?? [];

    return folders.flatMap((folder) => {
      const snapshot = this.states.get(folder.uri.fsPath)?.snapshot;

      return snapshot ? [snapshot] : [];
    });
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.snapshots.clear();
    this.repoSnapshots.clear();
    this.states.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private getState(folder: vscode.WorkspaceFolder): Promise<WorkspaceContributorRelationshipState> {
    const existingSnapshot = this.snapshots.get(folder.uri.fsPath);

    if (existingSnapshot) {
      return existingSnapshot;
    }

    const snapshotPromise = this.loadWorkspaceState(folder)
      .then((state) => {
        this.states.set(folder.uri.fsPath, state);
        this.emitter.fire();

        return state;
      })
      .catch((error) => {
        this.snapshots.delete(folder.uri.fsPath);
        throw error;
      });

    this.snapshots.set(folder.uri.fsPath, snapshotPromise);

    return snapshotPromise;
  }

  private async loadWorkspaceState(
    folder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceContributorRelationshipState> {
    if (folder.uri.scheme !== "file") {
      return {
        snapshot: createEmptySnapshot(folder, "not-git"),
      };
    }

    let repoRootPath: string;

    try {
      repoRootPath = await resolveRepoRoot(folder.uri.fsPath);
    } catch {
      return {
        snapshot: createEmptySnapshot(folder, "not-git"),
      };
    }

    const repoState = await this.getRepoState(repoRootPath, folder);

    return materializeWorkspaceContributorRelationshipState(folder, repoState);
  }

  private getRepoState(
    repoRootPath: string,
    folder: vscode.WorkspaceFolder,
    options: { readonly requireGraph?: boolean } = {},
  ): Promise<RepoContributorRelationshipState> {
    const requireGraph = options.requireGraph ?? false;
    const existingRepoSnapshot = this.repoSnapshots.get(repoRootPath);

    if (existingRepoSnapshot && !requireGraph) {
      return existingRepoSnapshot;
    }

    if (existingRepoSnapshot && requireGraph) {
      return existingRepoSnapshot.then((state) => {
        if (state.graph) {
          return state;
        }

        return this.reloadRepoState(repoRootPath, folder, { preferCache: false });
      });
    }

    return this.reloadRepoState(repoRootPath, folder, { preferCache: !requireGraph });
  }

  private reloadRepoState(
    repoRootPath: string,
    folder: vscode.WorkspaceFolder,
    options: { readonly preferCache: boolean },
  ): Promise<RepoContributorRelationshipState> {
    const repoSnapshotPromise = loadRepoContributorRelationshipState(
      folder,
      repoRootPath,
      this.cacheDirectoryPath,
      this.log,
      options,
    ).catch((error) => {
      this.repoSnapshots.delete(repoRootPath);
      throw error;
    });

    this.repoSnapshots.set(repoRootPath, repoSnapshotPromise);

    return repoSnapshotPromise;
  }

  private async inspectWorkspaceFolder(
    folder: vscode.WorkspaceFolder,
    selectedContributorKey?: string,
  ): Promise<WorkspaceContributorRelationshipSnapshot> {
    if (!selectedContributorKey) {
      return (await this.getState(folder)).snapshot;
    }

    const state = await this.getState(folder);

    if (state.snapshot.currentContributor?.key === selectedContributorKey) {
      return state.snapshot;
    }

    if (folder.uri.scheme !== "file") {
      return state.snapshot;
    }

    const repoRootPath = state.snapshot.repoRootPath;

    if (!repoRootPath) {
      return state.snapshot;
    }

    const repoState = await this.getRepoState(repoRootPath, folder, {
      requireGraph: true,
    });

    return materializeWorkspaceContributorRelationshipSnapshotForSelection(
      folder,
      repoState,
      selectedContributorKey,
    );
  }

  private debounceWarmSnapshots(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.scheduleWarmSnapshots();
    }, 5000);
  }

  private scheduleWarmSnapshots(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      void this.getState(folder);
    }
  }
}

async function loadRepoContributorRelationshipState(
  folder: vscode.WorkspaceFolder,
  repoRootPath: string,
  cacheDirectoryPath: string | undefined,
  log?: (message: string) => void,
  options: { readonly preferCache?: boolean } = {},
): Promise<RepoContributorRelationshipState> {
  log?.(`Loading contributor relationships for ${folder.name}...`);
  const [configuredContributor, headCommit, indexStamp] = await Promise.all([
    loadConfiguredContributor(repoRootPath),
    loadHeadCommit(repoRootPath),
    loadGitIndexStamp(repoRootPath),
  ]);
  const cachedState =
    options.preferCache === false
      ? undefined
      : await loadCachedState(
          cacheDirectoryPath,
          repoRootPath,
          configuredContributor,
          headCommit,
          indexStamp,
        );

  if (cachedState) {
    log?.(`Restored contributor relationships for ${folder.name} from cache.`);

    return restoreCachedRepoState(cachedState, configuredContributor, repoRootPath);
  }

  const loadStartedAtMs = Date.now();
  const [trackedPaths, contributorTouches] = await Promise.all([
    loadTrackedPaths(repoRootPath),
    loadContributorTouches(repoRootPath),
  ]);
  const loadElapsedMs = Date.now() - loadStartedAtMs;
  const buildStartedAtMs = Date.now();
  log?.(
    `Building contributor relationship graph for ${folder.name}: commits=${contributorTouches.length}, trackedFiles=${trackedPaths.size}.`,
  );
  const graph = buildContributorRelationshipGraph(contributorTouches, {
    currentContributor: configuredContributor,
    trackedPaths,
  });
  const buildElapsedMs = Date.now() - buildStartedAtMs;
  const topContributors = graph.contributors.slice(0, MAX_TOP_CONTRIBUTORS);

  if (!graph.contributors.length) {
    const snapshot: WorkspaceContributorRelationshipSnapshot = {
      ...createEmptySnapshot(folder, "no-history"),
      repoRootPath,
      configuredContributor,
      trackedFileCount: trackedPaths.size,
      topContributors,
      contributors: graph.contributors,
    };
    const state: RepoContributorRelationshipState = {
      graph,
      snapshot,
    };

    await saveCachedState(
      cacheDirectoryPath,
      repoRootPath,
      configuredContributor,
      headCommit,
      indexStamp,
      state,
    );

    return state;
  }

  const currentContributorSummary = graph.currentContributorKey
    ? graph.contributors.find((summary) => summary.contributor.key === graph.currentContributorKey)
    : undefined;

  if (!currentContributorSummary) {
    const snapshot: WorkspaceContributorRelationshipSnapshot = {
      ...createEmptySnapshot(folder, "no-current-contributor"),
      repoRootPath,
      configuredContributor,
      trackedFileCount: trackedPaths.size,
      contributorCount: graph.contributors.length,
      contributors: graph.contributors,
      topContributors,
    };
    const state: RepoContributorRelationshipState = {
      graph,
      snapshot,
    };

    await saveCachedState(
      cacheDirectoryPath,
      repoRootPath,
      configuredContributor,
      headCommit,
      indexStamp,
      state,
    );

    return state;
  }

  const relationships = rankContributorRelationships(
    graph,
    currentContributorSummary.contributor.key,
    {
      limit: graph.contributors.length,
    },
  );

  log?.(
    `Loaded contributor history for ${folder.name}: commits=${contributorTouches.length}, trackedFiles=${trackedPaths.size}, loadMs=${loadElapsedMs}, buildMs=${buildElapsedMs}.`,
  );
  log?.(
    `Loaded contributor relationships for ${folder.name}: current=${formatContributorIdentity(
      currentContributorSummary.contributor,
    )}, contributors=${graph.contributors.length}, relationships=${relationships.length}.`,
  );

  const snapshot: WorkspaceContributorRelationshipSnapshot = {
    workspaceFolderName: folder.name,
    workspaceFolderPath: folder.uri.fsPath,
    repoRootPath,
    status: "ready",
    configuredContributor,
    currentContributor: currentContributorSummary.contributor,
    currentContributorFileCount: currentContributorSummary.touchedFileCount,
    currentContributorCommitCount: currentContributorSummary.touchedCommitCount,
    currentContributorAreaFastWeight: currentContributorSummary.areaFastWeight,
    currentContributorAreaSlowWeight: currentContributorSummary.areaSlowWeight,
    currentContributorFileFastWeight: currentContributorSummary.fileFastWeight,
    currentContributorFileSlowWeight: currentContributorSummary.fileSlowWeight,
    trackedFileCount: trackedPaths.size,
    contributorCount: graph.contributors.length,
    contributors: graph.contributors,
    relationships,
    topContributors,
  };
  const contributorProfile = buildContributorSearchProfile(
    graph,
    currentContributorSummary.contributor.key,
  );
  const state: RepoContributorRelationshipState = {
    graph,
    snapshot,
    searchState: contributorProfile
      ? {
          profile: contributorProfile,
          repoRootPath,
          workspaceFolderPath: folder.uri.fsPath,
        }
      : undefined,
  };

  await saveCachedState(
    cacheDirectoryPath,
    repoRootPath,
    configuredContributor,
    headCommit,
    indexStamp,
    state,
  );

  return state;
}

function createCacheFilePath(cacheDirectoryPath: string, repoRootPath: string): string {
  const repoHash = createHash("sha1").update(repoRootPath).digest("hex");

  return path.join(cacheDirectoryPath, `${repoHash}.json`);
}

async function loadCachedState(
  cacheDirectoryPath: string | undefined,
  repoRootPath: string,
  configuredContributor: ContributorSelector | undefined,
  headCommit: string | undefined,
  indexStamp: string | undefined,
): Promise<RepoContributorRelationshipState | undefined> {
  if (!cacheDirectoryPath || !headCommit) {
    return undefined;
  }

  try {
    const cacheFilePath = createCacheFilePath(cacheDirectoryPath, repoRootPath);
    const cachedValue = JSON.parse(
      await readFile(cacheFilePath, "utf8"),
    ) as CachedWorkspaceContributorRelationshipState;

    if (
      !shouldRestoreCachedContributorState(cachedValue, {
        configuredContributor,
        headCommit,
        indexStamp,
      })
    ) {
      return undefined;
    }

    return {
      snapshot: cachedValue.snapshot,
      searchState: cachedValue.searchState
        ? {
            profile: {
              areaMetadata: {
                packageRootDirectories: new Set(cachedValue.searchState.packageRootDirectories),
                subtreeFileCounts: new Map(cachedValue.searchState.areaSubtreeFileCounts),
              },
              contributorKey: cachedValue.searchState.contributorKey,
              currentPathToLineageKey: new Map(cachedValue.searchState.currentPathToLineageKey),
              fileWeights: new Map(cachedValue.searchState.fileWeights),
              ownerShares: new Map(cachedValue.searchState.ownerShares),
              teammateCount: cachedValue.searchState.teammateCount,
              teamAreaWeights: new Map(cachedValue.searchState.teamAreaWeights),
              teamFileWeights: new Map(cachedValue.searchState.teamFileWeights),
            },
            repoRootPath,
            workspaceFolderPath: "",
          }
        : undefined,
    };
  } catch {
    return undefined;
  }
}

async function loadContributorTouches(repoRootPath: string): Promise<readonly ContributorTouch[]> {
  const stdout = await runGit(repoRootPath, [
    "log",
    "--use-mailmap",
    "--no-merges",
    "--find-renames",
    "-z",
    `--since=${formatContributorHistorySinceDate()}`,
    `--format=${COMMIT_SEPARATOR}%aN${FIELD_SEPARATOR}%aE${FIELD_SEPARATOR}%at${FIELD_SEPARATOR}%s`,
    "--numstat",
    "--",
  ]);

  return parseContributorTouches(stdout);
}

function parseContributorTouches(stdout: string): readonly ContributorTouch[] {
  const touches: ContributorTouch[] = [];

  for (const rawCommit of stdout.split(COMMIT_SEPARATOR)) {
    if (!rawCommit.trim()) {
      continue;
    }

    const tokens = rawCommit.split("\u0000");
    const header = tokens.shift()?.trim();

    if (!header) {
      continue;
    }

    const [authorName, authorEmail, authoredAtUnixSeconds, message] = header.split(FIELD_SEPARATOR);
    const files: ContributorTouchedFile[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = trimCommitToken(tokens[index]);

      if (!token) {
        continue;
      }

      const [addedLineCountToken, deletedLineCountToken, inlinePath] = token.split("\t");

      if (addedLineCountToken === undefined || deletedLineCountToken === undefined) {
        continue;
      }

      const addedLineCount = parseNumstatCount(addedLineCountToken);
      const deletedLineCount = parseNumstatCount(deletedLineCountToken);

      if (!inlinePath) {
        const previousPath = normalizePath(trimCommitToken(tokens[index + 1]));
        const path = normalizePath(trimCommitToken(tokens[index + 2]));

        if (previousPath && path) {
          files.push({
            addedLineCount,
            deletedLineCount,
            path,
            previousPath,
            status: "R",
          });
        }

        index += 2;
        continue;
      }

      const path = normalizePath(inlinePath);

      if (path) {
        files.push({
          addedLineCount,
          deletedLineCount,
          path,
        });
      }
    }

    if (!files.length) {
      continue;
    }

    const committedAtUnixSeconds = Number.parseInt(authoredAtUnixSeconds ?? "", 10);

    touches.push({
      contributor: createContributorIdentity(authorName, authorEmail),
      committedAtMs: Number.isFinite(committedAtUnixSeconds)
        ? committedAtUnixSeconds * 1000
        : undefined,
      files,
      message,
      touchedPaths: EMPTY_TOUCHED_PATHS,
    });
  }

  return touches;
}

function trimCommitToken(value?: string): string {
  return value?.replace(/^\n+/, "").trim() ?? "";
}

function parseNumstatCount(value: string): number | undefined {
  const parsedValue = Number.parseInt(value, 10);

  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function formatContributorHistorySinceDate(nowMs = Date.now()): string {
  return new Date(nowMs - CONTRIBUTOR_HISTORY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
}

async function loadHeadCommit(repoRootPath: string): Promise<string | undefined> {
  try {
    const headCommit = (await runGit(repoRootPath, ["rev-parse", "HEAD"])).trim();

    return headCommit || undefined;
  } catch {
    return undefined;
  }
}

async function loadConfiguredContributor(
  repoRootPath: string,
): Promise<ContributorSelector | undefined> {
  let name: string | undefined;
  let email: string | undefined;

  try {
    const stdout = await runGit(repoRootPath, ["config", "--get-regexp", "^user\\.(name|email)$"]);

    for (const line of stdout.split("\n")) {
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        continue;
      }

      const separatorIndex = trimmedLine.search(/\s/);

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex);
      const value = trimmedLine.slice(separatorIndex).trim();

      if (!value) {
        continue;
      }

      if (key === "user.name") {
        name = value;
      } else if (key === "user.email") {
        email = value;
      }
    }
  } catch {
    return undefined;
  }

  if (!name && !email) {
    return undefined;
  }

  return {
    name,
    email,
  };
}
async function saveCachedState(
  cacheDirectoryPath: string | undefined,
  repoRootPath: string,
  configuredContributor: ContributorSelector | undefined,
  headCommit: string | undefined,
  indexStamp: string | undefined,
  state: RepoContributorRelationshipState,
): Promise<void> {
  if (!cacheDirectoryPath || !headCommit) {
    return;
  }

  try {
    await mkdir(cacheDirectoryPath, { recursive: true });
    const cacheFilePath = createCacheFilePath(cacheDirectoryPath, repoRootPath);
    const cachedValue: CachedWorkspaceContributorRelationshipState = {
      configuredContributor,
      headCommit,
      indexStamp,
      searchState: state.searchState
        ? {
            areaSubtreeFileCounts: [
              ...state.searchState.profile.areaMetadata.subtreeFileCounts.entries(),
            ],
            contributorKey: state.searchState.profile.contributorKey,
            currentPathToLineageKey: [
              ...state.searchState.profile.currentPathToLineageKey.entries(),
            ],
            fileWeights: [...state.searchState.profile.fileWeights.entries()],
            ownerShares: [...state.searchState.profile.ownerShares.entries()],
            packageRootDirectories: [
              ...state.searchState.profile.areaMetadata.packageRootDirectories,
            ],
            teamAreaWeights: [...state.searchState.profile.teamAreaWeights.entries()],
            teamFileWeights: [...state.searchState.profile.teamFileWeights.entries()],
            teammateCount: state.searchState.profile.teammateCount,
          }
        : undefined,
      snapshot: state.snapshot,
      version: CACHE_VERSION,
    };

    await writeFile(cacheFilePath, JSON.stringify(cachedValue), "utf8");
  } catch {
    // Cache writes are opportunistic; ignore failures and use cold rebuild next time.
  }
}

function materializeWorkspaceContributorRelationshipState(
  folder: vscode.WorkspaceFolder,
  state: RepoContributorRelationshipState,
): WorkspaceContributorRelationshipState {
  return {
    snapshot: {
      ...state.snapshot,
      workspaceFolderName: folder.name,
      workspaceFolderPath: folder.uri.fsPath,
    },
    searchState: state.searchState
      ? {
          ...state.searchState,
          workspaceFolderPath: folder.uri.fsPath,
        }
      : undefined,
  };
}

function materializeWorkspaceContributorRelationshipSnapshotForSelection(
  folder: vscode.WorkspaceFolder,
  state: RepoContributorRelationshipState,
  selectedContributorKey: string,
): WorkspaceContributorRelationshipSnapshot {
  const graph = state.graph;

  if (!graph) {
    return materializeWorkspaceContributorRelationshipState(folder, state).snapshot;
  }

  const selectedContributorSummary = graph.contributors.find(
    (summary) => summary.contributor.key === selectedContributorKey,
  );

  if (!selectedContributorSummary) {
    return materializeWorkspaceContributorRelationshipState(folder, state).snapshot;
  }

  return {
    ...materializeWorkspaceContributorRelationshipState(folder, state).snapshot,
    status: "ready",
    currentContributor: selectedContributorSummary.contributor,
    currentContributorFileCount: selectedContributorSummary.touchedFileCount,
    currentContributorCommitCount: selectedContributorSummary.touchedCommitCount,
    currentContributorAreaFastWeight: selectedContributorSummary.areaFastWeight,
    currentContributorAreaSlowWeight: selectedContributorSummary.areaSlowWeight,
    currentContributorFileFastWeight: selectedContributorSummary.fileFastWeight,
    currentContributorFileSlowWeight: selectedContributorSummary.fileSlowWeight,
    contributorCount: graph.contributors.length,
    contributors: graph.contributors,
    relationships: rankContributorRelationships(graph, selectedContributorKey, {
      limit: graph.contributors.length,
    }),
    topContributors: graph.contributors.slice(0, MAX_TOP_CONTRIBUTORS),
  };
}

function restoreCachedRepoState(
  cachedState: RepoContributorRelationshipState,
  configuredContributor: ContributorSelector | undefined,
  repoRootPath: string,
): RepoContributorRelationshipState {
  return {
    snapshot: {
      ...cachedState.snapshot,
      configuredContributor,
      repoRootPath,
    },
    searchState: cachedState.searchState
      ? {
          ...cachedState.searchState,
          repoRootPath,
        }
      : undefined,
  };
}

function createEmptySnapshot(
  folder: vscode.WorkspaceFolder,
  status: WorkspaceContributorRelationshipStatus,
): WorkspaceContributorRelationshipSnapshot {
  return {
    workspaceFolderName: folder.name,
    workspaceFolderPath: folder.uri.fsPath,
    status,
    currentContributorFileCount: 0,
    currentContributorCommitCount: 0,
    currentContributorAreaFastWeight: 0,
    currentContributorAreaSlowWeight: 0,
    currentContributorFileFastWeight: 0,
    currentContributorFileSlowWeight: 0,
    trackedFileCount: 0,
    contributorCount: 0,
    contributors: [],
    relationships: [],
    topContributors: [],
  };
}
