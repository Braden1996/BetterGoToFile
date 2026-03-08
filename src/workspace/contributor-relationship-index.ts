import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildContributorSearchProfile,
  buildContributorRelationshipGraph,
  createContributorIdentity,
  formatContributorIdentity,
  rankContributorRelationships,
  type ContributorSearchProfile,
  type ContributorIdentity,
  type ContributorRelationship,
  type ContributorSelector,
  type ContributorSummary,
  type ContributorTouch,
  type ContributorTouchedFile,
} from "./contributor-relationship-model";
import { loadTrackedPaths, resolveRepoRoot, runGit } from "./git-utils";
import { collectPackageRootDirectories } from "./package-root";
import { normalizePath } from "./workspace-path";

const COMMIT_SEPARATOR = "\u001e";
const CACHE_VERSION = 3;
const CONTRIBUTOR_HISTORY_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_TOUCHED_PATHS: readonly string[] = [];
const FIELD_SEPARATOR = "\u001f";
const MAX_RELATIONSHIPS = 12;
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
  readonly relationships: readonly ContributorRelationship[];
  readonly topContributors: readonly ContributorSummary[];
}

interface WorkspaceContributorSearchState {
  readonly packageRootDirectories: ReadonlySet<string>;
  readonly profile: ContributorSearchProfile;
  readonly repoRootPath: string;
  readonly workspaceFolderPath: string;
}

interface CachedContributorSearchState {
  readonly contributorKey: string;
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

interface WorkspaceContributorRelationshipState {
  readonly searchState?: WorkspaceContributorSearchState;
  readonly snapshot: WorkspaceContributorRelationshipSnapshot;
}

export class ContributorRelationshipIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly snapshots = new Map<string, Promise<WorkspaceContributorRelationshipState>>();
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
        this.states.clear();
        this.emitter.fire();
        this.scheduleWarmSnapshots();
      }),
    );

    this.scheduleWarmSnapshots();
  }

  async inspectWorkspaceFolders(): Promise<readonly WorkspaceContributorRelationshipSnapshot[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    return Promise.all(folders.map(async (folder) => (await this.getState(folder)).snapshot));
  }

  getSearchState(workspaceFolderPath: string): WorkspaceContributorSearchState | undefined {
    return this.states.get(workspaceFolderPath)?.searchState;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.snapshots.clear();
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

    const snapshotPromise = loadWorkspaceContributorRelationshipState(
      folder,
      this.cacheDirectoryPath,
      this.log,
    )
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

async function loadWorkspaceContributorRelationshipState(
  folder: vscode.WorkspaceFolder,
  cacheDirectoryPath: string | undefined,
  log?: (message: string) => void,
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

  log?.(`Loading contributor relationships for ${folder.name}...`);
  const [configuredContributor, headCommit, indexStamp] = await Promise.all([
    loadConfiguredContributor(repoRootPath),
    loadHeadCommit(repoRootPath),
    loadGitIndexStamp(repoRootPath),
  ]);
  const cachedState = await loadCachedState(
    cacheDirectoryPath,
    repoRootPath,
    configuredContributor,
    headCommit,
    indexStamp,
  );

  if (cachedState) {
    log?.(`Restored contributor relationships for ${folder.name} from cache.`);

    return {
      snapshot: {
        ...cachedState.snapshot,
        configuredContributor,
        repoRootPath,
        workspaceFolderName: folder.name,
        workspaceFolderPath: folder.uri.fsPath,
      },
      searchState: cachedState.searchState
        ? {
            ...cachedState.searchState,
            repoRootPath,
            workspaceFolderPath: folder.uri.fsPath,
          }
        : undefined,
    };
  }

  const loadStartedAtMs = Date.now();
  const [trackedPaths, contributorTouches] = await Promise.all([
    loadTrackedPaths(repoRootPath),
    loadContributorTouches(repoRootPath),
  ]);
  const packageRootDirectories = collectPackageRootDirectories([...trackedPaths]);
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
    };
    const state: WorkspaceContributorRelationshipState = {
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
      topContributors,
    };
    const state: WorkspaceContributorRelationshipState = {
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
      limit: MAX_RELATIONSHIPS,
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
    relationships,
    topContributors,
  };
  const contributorProfile = buildContributorSearchProfile(
    graph,
    currentContributorSummary.contributor.key,
  );
  const state: WorkspaceContributorRelationshipState = {
    snapshot,
    searchState: contributorProfile
      ? {
          packageRootDirectories,
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

function createCacheContributorKey(contributor?: ContributorSelector): string {
  const normalizedName = contributor?.name?.trim().toLowerCase() ?? "";
  const normalizedEmail = contributor?.email?.trim().toLowerCase() ?? "";

  return `${normalizedName}${FIELD_SEPARATOR}${normalizedEmail}`;
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
): Promise<WorkspaceContributorRelationshipState | undefined> {
  if (!cacheDirectoryPath || !headCommit) {
    return undefined;
  }

  try {
    const cacheFilePath = createCacheFilePath(cacheDirectoryPath, repoRootPath);
    const cachedValue = JSON.parse(
      await readFile(cacheFilePath, "utf8"),
    ) as CachedWorkspaceContributorRelationshipState;

    if (
      cachedValue.version !== CACHE_VERSION ||
      cachedValue.headCommit !== headCommit ||
      cachedValue.indexStamp !== indexStamp ||
      createCacheContributorKey(cachedValue.configuredContributor) !==
        createCacheContributorKey(configuredContributor)
    ) {
      return undefined;
    }

    return {
      snapshot: cachedValue.snapshot,
      searchState: cachedValue.searchState
        ? {
            packageRootDirectories: new Set(cachedValue.searchState.packageRootDirectories),
            profile: {
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

async function loadGitIndexStamp(repoRootPath: string): Promise<string | undefined> {
  try {
    const rawIndexPath = (await runGit(repoRootPath, ["rev-parse", "--git-path", "index"])).trim();
    const indexPath = path.isAbsolute(rawIndexPath)
      ? rawIndexPath
      : path.resolve(repoRootPath, rawIndexPath);
    const indexStats = await stat(indexPath);

    return `${indexStats.size}:${Math.trunc(indexStats.mtimeMs)}`;
  } catch {
    return undefined;
  }
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
  const [name, email] = await Promise.all([
    readGitConfig(repoRootPath, "user.name"),
    readGitConfig(repoRootPath, "user.email"),
  ]);

  if (!name && !email) {
    return undefined;
  }

  return {
    name,
    email,
  };
}

async function readGitConfig(repoRootPath: string, key: string): Promise<string | undefined> {
  try {
    const value = (await runGit(repoRootPath, ["config", "--get", key])).trim();

    return value || undefined;
  } catch {
    return undefined;
  }
}

async function saveCachedState(
  cacheDirectoryPath: string | undefined,
  repoRootPath: string,
  configuredContributor: ContributorSelector | undefined,
  headCommit: string | undefined,
  indexStamp: string | undefined,
  state: WorkspaceContributorRelationshipState,
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
            contributorKey: state.searchState.profile.contributorKey,
            currentPathToLineageKey: [
              ...state.searchState.profile.currentPathToLineageKey.entries(),
            ],
            fileWeights: [...state.searchState.profile.fileWeights.entries()],
            ownerShares: [...state.searchState.profile.ownerShares.entries()],
            packageRootDirectories: [...state.searchState.packageRootDirectories],
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
    relationships: [],
    topContributors: [],
  };
}
