import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type GitignoredVisibility } from "../src/config/schema";
import {
  resolveScoringPresetValues,
  sanitizeScoringPresetOverride,
  type ScoringPresetId,
  type ScoringPresetOverride,
} from "../src/config/scoring-presets";
import { shouldIncludeGitignoredFile } from "../src/search/gitignored-visibility";
import { decayFrecencyScore } from "../src/search/frecency-store";
import { formatDebugScoreDetail } from "../src/search/search-score-detail";
import {
  scoreSearchCandidates,
  type SearchCandidate,
  type SearchScoreBreakdown,
} from "../src/search/search-ranking";
import {
  collectPackageRootDirectories,
  findNearestPackageRoot,
} from "../src/workspace/package-root";
import {
  buildContributorRelationshipGraph,
  buildContributorSearchProfile,
  createContributorIdentity,
  type ContributorIdentity,
  type ContributorSearchProfile,
  type ContributorSelector,
  type ContributorTouch,
  type ContributorTouchedFile,
  scoreContributorFile,
} from "../src/workspace/contributor-relationship-model";

const COMMIT_SEPARATOR = "\u001e";
const CONTRIBUTOR_HISTORY_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const BETTER_GO_TO_FILE_EXTENSION_ID = "local.better-go-to-file";
const execFileAsync = promisify(execFile);
const EMPTY_TOUCHED_PATHS: readonly string[] = [];
const FIELD_SEPARATOR = "\u001f";
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

type GitTrackingState = "tracked" | "untracked" | "ignored" | "unknown";
type ContributorSelectionSource = "override" | "git-config" | "none";
type RepositoryContributorStatus =
  | "ready"
  | "not-git"
  | "no-contributor"
  | "no-history"
  | "no-current-contributor";
type RepositoryFrecencySelectionSource = "auto" | "file" | "none";
type RepositoryFrecencyStatus = "ready" | "disabled" | "not-found" | "invalid";

interface RepositorySearchOptions {
  readonly repoPath: string;
  readonly query: string;
  readonly preset: ScoringPresetId;
  readonly customPreset?: ScoringPresetOverride;
  readonly activePath?: string;
  readonly openPaths?: readonly string[];
  readonly gitignoredVisibility?: GitignoredVisibility;
  readonly excludedDirectories?: readonly string[];
  readonly contributor?: ContributorSelector;
  readonly frecencyFilePath?: string;
  readonly noFrecency?: boolean;
  readonly workspaceStorageRoots?: readonly string[];
}

interface RepositoryExplainOptions extends RepositorySearchOptions {
  readonly targetPath: string;
  readonly contextWindow?: number;
}

export type RepositoryContributorFilePrior = ReturnType<typeof scoreContributorFile>;

interface PersistedFrecencyRecord {
  readonly score: number;
  readonly referenceTime: number;
  readonly lastAccessed: number;
  readonly accessCount: number;
}

interface PersistedFrecencySnapshot {
  readonly version: 1;
  readonly halfLifeMs: number;
  readonly records: Record<string, PersistedFrecencyRecord>;
}

interface RepositoryContributorStateBase {
  readonly status: RepositoryContributorStatus;
  readonly selectionSource: ContributorSelectionSource;
  readonly configuredContributor?: ContributorSelector;
  readonly currentContributor?: ContributorIdentity;
  readonly contributorCount: number;
  readonly teammateCount: number;
}

export interface ReadyRepositoryContributorState extends RepositoryContributorStateBase {
  readonly status: "ready";
  readonly currentContributor: ContributorIdentity;
  readonly packageRootDirectories: ReadonlySet<string>;
  readonly profile: ContributorSearchProfile;
}

interface NonReadyRepositoryContributorState extends RepositoryContributorStateBase {
  readonly status: Exclude<RepositoryContributorStatus, "ready">;
}

export type RepositoryContributorState =
  | ReadyRepositoryContributorState
  | NonReadyRepositoryContributorState;

interface RepositoryFrecencyStateBase {
  readonly status: RepositoryFrecencyStatus;
  readonly source: RepositoryFrecencySelectionSource;
  readonly filePath?: string;
  readonly workspacePath?: string;
  readonly editor?: string;
  readonly recordCount: number;
}

interface ReadyRepositoryFrecencyState extends RepositoryFrecencyStateBase {
  readonly status: "ready";
  readonly filePath: string;
  readonly records: ReadonlyMap<string, PersistedFrecencyRecord>;
}

interface NonReadyRepositoryFrecencyState extends RepositoryFrecencyStateBase {
  readonly status: Exclude<RepositoryFrecencyStatus, "ready">;
}

export type RepositoryFrecencyState =
  | ReadyRepositoryFrecencyState
  | NonReadyRepositoryFrecencyState;

interface RankedRepositoryCandidate {
  readonly rank: number;
  readonly candidate: LocalSearchCandidate;
  readonly total: number;
  readonly breakdown: SearchScoreBreakdown;
  readonly contributorPrior?: RepositoryContributorFilePrior;
  readonly debugDetail: string;
  readonly gitTrackingState: GitTrackingState;
}

interface RepositorySearchResult {
  readonly repoPath: string;
  readonly query: string;
  readonly preset: ScoringPresetId;
  readonly totalCandidateCount: number;
  readonly visibleCandidateCount: number;
  readonly activePath?: string;
  readonly contributorState: RepositoryContributorState;
  readonly frecencyState: RepositoryFrecencyState;
  readonly results: readonly RankedRepositoryCandidate[];
}

interface RepositoryExplainResult extends RepositorySearchResult {
  readonly targetPath: string;
  readonly target?: RankedRepositoryCandidate;
  readonly surroundingResults: readonly RankedRepositoryCandidate[];
}

interface LocalSearchCandidate extends SearchCandidate {}

interface LoadedGitState {
  readonly repoRootPath?: string;
  readonly ignoredDirectoryPrefixes?: readonly string[];
  readonly ignoredPaths?: ReadonlySet<string>;
  readonly trackedPaths?: ReadonlySet<string>;
}

interface ScoredRepositoryCandidates {
  readonly repoPath: string;
  readonly query: string;
  readonly preset: ScoringPresetId;
  readonly totalCandidateCount: number;
  readonly visibleCandidateCount: number;
  readonly activePath?: string;
  readonly contributorState: RepositoryContributorState;
  readonly frecencyState: RepositoryFrecencyState;
  readonly ranked: readonly RankedRepositoryCandidate[];
}

interface WorkspaceStorageRoot {
  readonly editor: string;
  readonly path: string;
}

interface FrecencyDiscoveryMatch {
  readonly editor: string;
  readonly filePath: string;
  readonly matchDepth: number;
  readonly matchKind: "exact" | "ancestor" | "descendant";
  readonly modifiedAtMs: number;
  readonly workspacePath: string;
}

interface WorkspaceFolderMatch {
  readonly matchDepth: number;
  readonly matchKind: "exact" | "ancestor" | "descendant";
  readonly workspacePath: string;
}

export async function validateRepositoryPath(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  const pathStat = await stat(resolvedPath);

  if (!pathStat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

export function parseCustomPresetInput(input: string): ScoringPresetOverride {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return {};
  }

  try {
    return sanitizeScoringPresetOverride(JSON.parse(trimmedInput));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid custom preset JSON: ${message}`);
  }
}

export async function searchRepository(
  options: RepositorySearchOptions,
  limit: number,
): Promise<RepositorySearchResult> {
  const scoredCandidates = await scoreRepositoryCandidates(options);

  return {
    repoPath: scoredCandidates.repoPath,
    query: scoredCandidates.query,
    preset: scoredCandidates.preset,
    totalCandidateCount: scoredCandidates.totalCandidateCount,
    visibleCandidateCount: scoredCandidates.visibleCandidateCount,
    activePath: scoredCandidates.activePath,
    contributorState: scoredCandidates.contributorState,
    frecencyState: scoredCandidates.frecencyState,
    results: scoredCandidates.ranked.slice(0, limit),
  };
}

export async function explainRepositoryCandidate(
  options: RepositoryExplainOptions,
): Promise<RepositoryExplainResult> {
  const scoredCandidates = await scoreRepositoryCandidates(options);
  const targetPath = toRepositoryRelativePath(options.targetPath, scoredCandidates.repoPath);
  const contextWindow = Math.max(0, options.contextWindow ?? 2);
  const target = scoredCandidates.ranked.find(
    (candidate) => candidate.candidate.relativePath === targetPath,
  );

  if (!target) {
    return {
      repoPath: scoredCandidates.repoPath,
      query: scoredCandidates.query,
      preset: scoredCandidates.preset,
      totalCandidateCount: scoredCandidates.totalCandidateCount,
      visibleCandidateCount: scoredCandidates.visibleCandidateCount,
      activePath: scoredCandidates.activePath,
      contributorState: scoredCandidates.contributorState,
      frecencyState: scoredCandidates.frecencyState,
      targetPath,
      results: scoredCandidates.ranked.slice(0, Math.min(10, scoredCandidates.ranked.length)),
      surroundingResults: [],
    };
  }

  const surroundingStart = Math.max(0, target.rank - 1 - contextWindow);
  const surroundingEnd = Math.min(scoredCandidates.ranked.length, target.rank + contextWindow);

  return {
    repoPath: scoredCandidates.repoPath,
    query: scoredCandidates.query,
    preset: scoredCandidates.preset,
    totalCandidateCount: scoredCandidates.totalCandidateCount,
    visibleCandidateCount: scoredCandidates.visibleCandidateCount,
    activePath: scoredCandidates.activePath,
    contributorState: scoredCandidates.contributorState,
    frecencyState: scoredCandidates.frecencyState,
    targetPath,
    target,
    results: scoredCandidates.ranked.slice(0, Math.min(10, scoredCandidates.ranked.length)),
    surroundingResults: scoredCandidates.ranked.slice(surroundingStart, surroundingEnd),
  };
}

async function scoreRepositoryCandidates(
  options: RepositorySearchOptions,
): Promise<ScoredRepositoryCandidates> {
  const repoPath = await validateRepositoryPath(options.repoPath);
  const candidates = await scanRepositoryCandidates(
    repoPath,
    options.excludedDirectories ??
      DEFAULT_BETTER_GO_TO_FILE_CONFIG.workspaceIndex.excludedDirectories,
  );
  const gitState = await loadGitState(repoPath);
  const contributorState = await loadContributorSearchState(gitState, options.contributor);
  const frecencyState = await loadFrecencyState(
    repoPath,
    options.frecencyFilePath,
    options.noFrecency ?? false,
    options.workspaceStorageRoots,
  );
  const gitignoredVisibility =
    options.gitignoredVisibility ?? DEFAULT_BETTER_GO_TO_FILE_CONFIG.gitignored.visibility;
  const visibleCandidates = candidates.filter((candidate) => {
    const gitTrackingState = getGitTrackingState(candidate.relativePath, gitState);

    return (
      gitTrackingState !== "ignored" ||
      shouldIncludeGitignoredFile(options.query, gitignoredVisibility)
    );
  });
  const activePath = options.activePath
    ? toRepositoryRelativePath(options.activePath, repoPath)
    : undefined;
  const openPaths = new Set(
    (options.openPaths ?? []).map((openPath) => toRepositoryRelativePath(openPath, repoPath)),
  );
  const activePackageRoot = activePath
    ? candidates.find((candidate) => candidate.relativePath === activePath)?.packageRoot
    : undefined;
  const scoringValues = resolveScoringPresetValues(options.preset, options.customPreset);
  const frecencyScoreByPath = createFrecencyScoreByPath(
    visibleCandidates,
    frecencyState,
    Date.now(),
    scoringValues.frecencyHalfLifeDays * DAY_MS,
  );
  const contributorPriorByPath = createContributorPriorByPath(visibleCandidates, contributorState);
  const ranked = scoreSearchCandidates(
    visibleCandidates,
    options.query,
    {
      activePath,
      activePackageRoot,
      openPaths,
      getFrecencyScore: (relativePath) => frecencyScoreByPath.get(relativePath) ?? 0,
      getGitPrior: (candidate) => contributorPriorByPath.get(candidate.relativePath)?.total ?? 0,
      getGitTrackingState: (candidate) => getGitTrackingState(candidate.relativePath, gitState),
    },
    visibleCandidates.length,
    scoringValues.ranking,
  ).map(({ candidate, total, breakdown }, index) => ({
    rank: index + 1,
    candidate,
    total,
    breakdown,
    contributorPrior: contributorPriorByPath.get(candidate.relativePath),
    debugDetail: formatDebugScoreDetail(total, breakdown),
    gitTrackingState: getGitTrackingState(candidate.relativePath, gitState),
  }));

  return {
    repoPath,
    query: options.query,
    preset: options.preset,
    totalCandidateCount: candidates.length,
    visibleCandidateCount: visibleCandidates.length,
    activePath,
    contributorState,
    frecencyState,
    ranked,
  };
}

async function scanRepositoryCandidates(
  repoPath: string,
  excludedDirectories: readonly string[],
): Promise<readonly LocalSearchCandidate[]> {
  const relativePaths = await collectRepositoryPaths(repoPath, new Set(excludedDirectories));
  const packageRootDirectories = collectPackageRootDirectories(relativePaths);

  return relativePaths.map((relativePath) => {
    const basename = path.posix.basename(relativePath);
    const directory = normalizeDirectory(path.posix.dirname(relativePath));

    return {
      basename,
      directory,
      packageRoot: findNearestPackageRoot(directory, packageRootDirectories),
      relativePath,
      searchBasename: basename.toLowerCase(),
      searchPath: relativePath.toLowerCase(),
    };
  });
}

async function collectRepositoryPaths(
  repoPath: string,
  excludedDirectories: ReadonlySet<string>,
  relativeDirectory = "",
): Promise<string[]> {
  const absoluteDirectory = relativeDirectory ? path.join(repoPath, relativeDirectory) : repoPath;
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const relativePaths: string[] = [];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryRelativePath = joinRelativePath(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) {
        continue;
      }

      relativePaths.push(
        ...(await collectRepositoryPaths(repoPath, excludedDirectories, entryRelativePath)),
      );
      continue;
    }

    if (entry.isFile()) {
      relativePaths.push(entryRelativePath);
    }
  }

  return relativePaths;
}

function createFrecencyScoreByPath(
  candidates: readonly LocalSearchCandidate[],
  frecencyState: RepositoryFrecencyState,
  now: number,
  halfLifeMs: number,
): ReadonlyMap<string, number> {
  if (frecencyState.status !== "ready") {
    return new Map();
  }

  return new Map(
    candidates.map((candidate) => [
      candidate.relativePath,
      decayFrecencyScore(
        frecencyState.records.get(candidate.relativePath) ?? {
          score: 0,
          referenceTime: now,
          lastAccessed: now,
          accessCount: 0,
        },
        now,
        halfLifeMs,
      ),
    ]),
  );
}

async function loadFrecencyState(
  repoPath: string,
  frecencyFilePath: string | undefined,
  noFrecency: boolean,
  workspaceStorageRoots?: readonly string[],
): Promise<RepositoryFrecencyState> {
  if (noFrecency) {
    return createFrecencyState("disabled", "none");
  }

  if (frecencyFilePath) {
    return loadFrecencyStateFromFile(path.resolve(frecencyFilePath), repoPath, "file");
  }

  const discoveredMatch = await discoverFrecencyFile(repoPath, workspaceStorageRoots);

  if (!discoveredMatch) {
    return createFrecencyState("not-found", "auto");
  }

  return loadFrecencyStateFromFile(
    discoveredMatch.filePath,
    repoPath,
    "auto",
    discoveredMatch.workspacePath,
    discoveredMatch.editor,
  );
}

async function loadFrecencyStateFromFile(
  frecencyFilePath: string,
  repoPath: string,
  source: Exclude<RepositoryFrecencySelectionSource, "none">,
  workspacePath?: string,
  editor?: string,
): Promise<RepositoryFrecencyState> {
  let contents: string;

  try {
    contents = await readFile(frecencyFilePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError?.code === "ENOENT") {
      return createFrecencyState("not-found", source, {
        editor,
        filePath: frecencyFilePath,
      });
    }

    throw error;
  }

  const parsed = JSON.parse(contents) as PersistedFrecencySnapshot;

  if (!isPersistedFrecencySnapshot(parsed)) {
    return createFrecencyState("invalid", source, {
      editor,
      filePath: frecencyFilePath,
    });
  }

  const inferredWorkspacePath =
    workspacePath ?? (await inferWorkspacePathFromFrecencyFile(frecencyFilePath));
  const mappedRecords = mapFrecencyRecordsToRepo(
    parsed.records,
    repoPath,
    inferredWorkspacePath ?? repoPath,
  );

  return {
    status: "ready",
    source,
    filePath: frecencyFilePath,
    workspacePath: inferredWorkspacePath,
    editor,
    recordCount: mappedRecords.size,
    records: mappedRecords,
  };
}

function createFrecencyState(
  status: Exclude<RepositoryFrecencyStatus, "ready">,
  source: RepositoryFrecencySelectionSource,
  details: Partial<Omit<RepositoryFrecencyStateBase, "status" | "source" | "recordCount">> = {},
): RepositoryFrecencyState {
  return {
    status,
    source,
    recordCount: 0,
    ...details,
  };
}

async function discoverFrecencyFile(
  repoPath: string,
  workspaceStorageRoots?: readonly string[],
): Promise<FrecencyDiscoveryMatch | undefined> {
  const matches: FrecencyDiscoveryMatch[] = [];
  const repoRootPath = path.resolve(repoPath);

  for (const workspaceStorageRoot of getWorkspaceStorageRoots(workspaceStorageRoots)) {
    const entries = await readWorkspaceStorageEntries(workspaceStorageRoot.path);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspaceStoragePath = path.join(workspaceStorageRoot.path, entry.name);
      const workspacePaths = await loadWorkspaceStoragePaths(workspaceStoragePath);
      const workspaceMatch = selectWorkspaceFolderMatch(repoRootPath, workspacePaths);

      if (!workspaceMatch) {
        continue;
      }

      const frecencyFilePath = path.join(
        workspaceStoragePath,
        BETTER_GO_TO_FILE_EXTENSION_ID,
        "frecency.json",
      );

      try {
        const fileStats = await stat(frecencyFilePath);

        if (!fileStats.isFile()) {
          continue;
        }

        matches.push({
          editor: workspaceStorageRoot.editor,
          filePath: frecencyFilePath,
          matchDepth: workspaceMatch.matchDepth,
          matchKind: workspaceMatch.matchKind,
          modifiedAtMs: fileStats.mtimeMs,
          workspacePath: workspaceMatch.workspacePath,
        });
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;

        if (nodeError?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return matches.sort(compareFrecencyDiscoveryMatches)[0];
}

function getWorkspaceStorageRoots(
  overrideRoots?: readonly string[],
): readonly WorkspaceStorageRoot[] {
  if (overrideRoots?.length) {
    return overrideRoots.map((rootPath) => ({
      editor: path.basename(path.dirname(path.dirname(rootPath))) || "workspaceStorage",
      path: rootPath,
    }));
  }

  const home = process.env.HOME;

  if (!home) {
    return [];
  }

  switch (process.platform) {
    case "darwin":
      return [
        {
          editor: "Code",
          path: path.join(
            home,
            "Library",
            "Application Support",
            "Code",
            "User",
            "workspaceStorage",
          ),
        },
        {
          editor: "Cursor",
          path: path.join(
            home,
            "Library",
            "Application Support",
            "Cursor",
            "User",
            "workspaceStorage",
          ),
        },
        {
          editor: "Code - Insiders",
          path: path.join(
            home,
            "Library",
            "Application Support",
            "Code - Insiders",
            "User",
            "workspaceStorage",
          ),
        },
        {
          editor: "VSCodium",
          path: path.join(
            home,
            "Library",
            "Application Support",
            "VSCodium",
            "User",
            "workspaceStorage",
          ),
        },
        {
          editor: "Windsurf",
          path: path.join(
            home,
            "Library",
            "Application Support",
            "Windsurf",
            "User",
            "workspaceStorage",
          ),
        },
      ];
    case "win32": {
      const appData = process.env.APPDATA;

      if (!appData) {
        return [];
      }

      return [
        {
          editor: "Code",
          path: path.join(appData, "Code", "User", "workspaceStorage"),
        },
        {
          editor: "Cursor",
          path: path.join(appData, "Cursor", "User", "workspaceStorage"),
        },
        {
          editor: "Code - Insiders",
          path: path.join(appData, "Code - Insiders", "User", "workspaceStorage"),
        },
        {
          editor: "VSCodium",
          path: path.join(appData, "VSCodium", "User", "workspaceStorage"),
        },
        {
          editor: "Windsurf",
          path: path.join(appData, "Windsurf", "User", "workspaceStorage"),
        },
      ];
    }
    default:
      return [
        {
          editor: "Code",
          path: path.join(home, ".config", "Code", "User", "workspaceStorage"),
        },
        {
          editor: "Cursor",
          path: path.join(home, ".config", "Cursor", "User", "workspaceStorage"),
        },
        {
          editor: "Code - Insiders",
          path: path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"),
        },
        {
          editor: "VSCodium",
          path: path.join(home, ".config", "VSCodium", "User", "workspaceStorage"),
        },
        {
          editor: "Windsurf",
          path: path.join(home, ".config", "Windsurf", "User", "workspaceStorage"),
        },
      ];
  }
}

async function readWorkspaceStorageEntries(workspaceStoragePath: string) {
  try {
    return await readdir(workspaceStoragePath, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function loadWorkspaceStoragePaths(workspaceStoragePath: string): Promise<readonly string[]> {
  try {
    const workspaceJsonPath = path.join(workspaceStoragePath, "workspace.json");
    const workspaceJson = JSON.parse(await readFile(workspaceJsonPath, "utf8")) as {
      folder?: string;
      workspace?: string;
    };

    if (typeof workspaceJson.folder === "string") {
      return [path.resolve(fileURLToPath(workspaceJson.folder))];
    }

    if (typeof workspaceJson.workspace === "string") {
      return loadCodeWorkspaceFolders(path.resolve(fileURLToPath(workspaceJson.workspace)));
    }

    return [];
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function loadCodeWorkspaceFolders(workspaceFilePath: string): Promise<readonly string[]> {
  try {
    const contents = await readFile(workspaceFilePath, "utf8");
    const parsed = JSON.parse(contents) as {
      folders?: readonly { path?: string; uri?: string }[];
    };
    const workspaceDirectory = path.dirname(workspaceFilePath);

    return (parsed.folders ?? []).flatMap((folder) => {
      if (typeof folder.path === "string") {
        return [path.resolve(workspaceDirectory, folder.path)];
      }

      if (typeof folder.uri === "string" && folder.uri.startsWith("file://")) {
        return [path.resolve(fileURLToPath(folder.uri))];
      }

      return [];
    });
  } catch {
    return [];
  }
}

function selectWorkspaceFolderMatch(
  repoPath: string,
  workspacePaths: readonly string[],
): WorkspaceFolderMatch | undefined {
  const matches: WorkspaceFolderMatch[] = [];

  for (const workspacePath of workspacePaths) {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const repoRelativeToWorkspace = getContainedRelativePath(normalizedWorkspacePath, repoPath);

    if (repoRelativeToWorkspace !== undefined) {
      matches.push({
        matchDepth: getRelativePathDepth(repoRelativeToWorkspace),
        matchKind: repoRelativeToWorkspace ? "ancestor" : "exact",
        workspacePath: normalizedWorkspacePath,
      });
      continue;
    }

    const workspaceRelativeToRepo = getContainedRelativePath(repoPath, normalizedWorkspacePath);

    if (workspaceRelativeToRepo !== undefined) {
      matches.push({
        matchDepth: getRelativePathDepth(workspaceRelativeToRepo),
        matchKind: "descendant",
        workspacePath: normalizedWorkspacePath,
      });
    }
  }

  matches.sort(compareWorkspaceFolderMatches);

  return matches[0];
}

function compareWorkspaceFolderMatches(
  left: WorkspaceFolderMatch,
  right: WorkspaceFolderMatch,
): number {
  const kindDelta =
    getWorkspaceMatchPriority(right.matchKind) - getWorkspaceMatchPriority(left.matchKind);

  if (kindDelta !== 0) {
    return kindDelta;
  }

  if (left.matchKind === "ancestor") {
    return (
      left.matchDepth - right.matchDepth || right.workspacePath.length - left.workspacePath.length
    );
  }

  if (left.matchKind === "descendant") {
    return (
      left.matchDepth - right.matchDepth || left.workspacePath.length - right.workspacePath.length
    );
  }

  return right.workspacePath.length - left.workspacePath.length;
}

function compareFrecencyDiscoveryMatches(
  left: FrecencyDiscoveryMatch,
  right: FrecencyDiscoveryMatch,
): number {
  return (
    compareWorkspaceMatchDetails(left.matchKind, left.matchDepth, left.workspacePath, right) ||
    right.modifiedAtMs - left.modifiedAtMs ||
    left.filePath.localeCompare(right.filePath)
  );
}

function compareWorkspaceMatchDetails(
  leftMatchKind: WorkspaceFolderMatch["matchKind"],
  leftMatchDepth: number,
  leftWorkspacePath: string,
  right: Pick<WorkspaceFolderMatch, "matchDepth" | "matchKind" | "workspacePath">,
): number {
  const kindDelta =
    getWorkspaceMatchPriority(right.matchKind) - getWorkspaceMatchPriority(leftMatchKind);

  if (kindDelta !== 0) {
    return kindDelta;
  }

  if (leftMatchKind === "ancestor") {
    return (
      leftMatchDepth - right.matchDepth || right.workspacePath.length - leftWorkspacePath.length
    );
  }

  if (leftMatchKind === "descendant") {
    return (
      leftMatchDepth - right.matchDepth || leftWorkspacePath.length - right.workspacePath.length
    );
  }

  return right.workspacePath.length - leftWorkspacePath.length;
}

function getWorkspaceMatchPriority(matchKind: WorkspaceFolderMatch["matchKind"]): number {
  switch (matchKind) {
    case "exact":
      return 3;
    case "ancestor":
      return 2;
    case "descendant":
      return 1;
  }
}

function getContainedRelativePath(parentPath: string, childPath: string): string | undefined {
  const relativePath = path.relative(parentPath, childPath);

  if (!relativePath) {
    return "";
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return normalizePath(relativePath);
}

function getRelativePathDepth(relativePath: string): number {
  if (!relativePath) {
    return 0;
  }

  return relativePath.split("/").length;
}

async function inferWorkspacePathFromFrecencyFile(
  frecencyFilePath: string,
): Promise<string | undefined> {
  const workspaceStoragePath = path.dirname(path.dirname(frecencyFilePath));
  const workspacePaths = await loadWorkspaceStoragePaths(workspaceStoragePath);

  return workspacePaths[0];
}

function mapFrecencyRecordsToRepo(
  records: PersistedFrecencySnapshot["records"],
  repoPath: string,
  workspacePath: string,
): ReadonlyMap<string, PersistedFrecencyRecord> {
  const repoRelativeToWorkspace = getContainedRelativePath(workspacePath, repoPath);
  const workspaceRelativeToRepo = getContainedRelativePath(repoPath, workspacePath);
  const mappedRecords = new Map<string, PersistedFrecencyRecord>();

  if (repoRelativeToWorkspace !== undefined) {
    const prefix = repoRelativeToWorkspace ? `${repoRelativeToWorkspace}/` : "";

    for (const [storedRelativePath, record] of Object.entries(records)) {
      const normalizedStoredPath = normalizePath(storedRelativePath);

      if (!normalizedStoredPath) {
        continue;
      }

      const repoRelativePath = prefix
        ? normalizedStoredPath.startsWith(prefix)
          ? normalizedStoredPath.slice(prefix.length)
          : undefined
        : normalizedStoredPath;

      if (!repoRelativePath) {
        continue;
      }

      mappedRecords.set(repoRelativePath, record);
    }

    return mappedRecords;
  }

  if (workspaceRelativeToRepo !== undefined) {
    const prefix = workspaceRelativeToRepo ? `${workspaceRelativeToRepo}/` : "";

    for (const [storedRelativePath, record] of Object.entries(records)) {
      const normalizedStoredPath = normalizePath(storedRelativePath);

      if (!normalizedStoredPath) {
        continue;
      }

      mappedRecords.set(prefix ? `${prefix}${normalizedStoredPath}` : normalizedStoredPath, record);
    }
  }

  return mappedRecords;
}

function isPersistedFrecencySnapshot(value: unknown): value is PersistedFrecencySnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<PersistedFrecencySnapshot>;

  return (
    snapshot.version === 1 &&
    typeof snapshot.halfLifeMs === "number" &&
    Boolean(snapshot.records) &&
    typeof snapshot.records === "object" &&
    Object.values(snapshot.records).every(isPersistedFrecencyRecord)
  );
}

function isPersistedFrecencyRecord(value: unknown): value is PersistedFrecencyRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<PersistedFrecencyRecord>;

  return (
    typeof record.score === "number" &&
    typeof record.referenceTime === "number" &&
    typeof record.lastAccessed === "number" &&
    typeof record.accessCount === "number"
  );
}

function createContributorPriorByPath(
  candidates: readonly LocalSearchCandidate[],
  contributorState: RepositoryContributorState,
): ReadonlyMap<string, RepositoryContributorFilePrior> {
  if (contributorState.status !== "ready") {
    return new Map();
  }

  return new Map(
    candidates.map((candidate) => [
      candidate.relativePath,
      scoreContributorFile(
        contributorState.profile,
        candidate.relativePath,
        contributorState.packageRootDirectories,
      ),
    ]),
  );
}

async function loadContributorSearchState(
  gitState: LoadedGitState,
  contributorOverride?: ContributorSelector,
): Promise<RepositoryContributorState> {
  if (!gitState.repoRootPath) {
    return createContributorState("not-git", "none");
  }

  const normalizedContributorOverride = normalizeContributorSelector(contributorOverride);
  const configuredContributor =
    normalizedContributorOverride ?? (await loadConfiguredContributor(gitState.repoRootPath));
  const selectionSource = normalizedContributorOverride
    ? "override"
    : configuredContributor
      ? "git-config"
      : "none";

  if (!configuredContributor) {
    return createContributorState("no-contributor", selectionSource);
  }

  const trackedPaths = gitState.trackedPaths ?? (await loadTrackedPaths(gitState.repoRootPath));
  const contributorTouches = await loadContributorTouches(gitState.repoRootPath);
  const graph = buildContributorRelationshipGraph(contributorTouches, {
    currentContributor: configuredContributor,
    trackedPaths,
  });

  if (!graph.contributors.length) {
    return createContributorState("no-history", selectionSource, configuredContributor);
  }

  const currentContributorSummary = graph.currentContributorKey
    ? graph.contributors.find((summary) => summary.contributor.key === graph.currentContributorKey)
    : undefined;

  if (!currentContributorSummary) {
    return createContributorState(
      "no-current-contributor",
      selectionSource,
      configuredContributor,
      undefined,
      graph.contributors.length,
    );
  }

  const profile = buildContributorSearchProfile(graph, currentContributorSummary.contributor.key);

  if (!profile) {
    return createContributorState(
      "no-history",
      selectionSource,
      configuredContributor,
      currentContributorSummary.contributor,
      graph.contributors.length,
    );
  }

  return {
    status: "ready",
    selectionSource,
    configuredContributor,
    currentContributor: currentContributorSummary.contributor,
    contributorCount: graph.contributors.length,
    teammateCount: profile.teammateCount,
    packageRootDirectories: collectPackageRootDirectories([...trackedPaths]),
    profile,
  };
}

function createContributorState(
  status: Exclude<RepositoryContributorStatus, "ready">,
  selectionSource: ContributorSelectionSource,
  configuredContributor?: ContributorSelector,
  currentContributor?: ContributorIdentity,
  contributorCount = 0,
): RepositoryContributorState {
  return {
    status,
    selectionSource,
    configuredContributor,
    currentContributor,
    contributorCount,
    teammateCount: 0,
  };
}

function normalizeContributorSelector(
  contributor?: ContributorSelector,
): ContributorSelector | undefined {
  const name = contributor?.name?.trim();
  const email = contributor?.email?.trim();

  if (!name && !email) {
    return undefined;
  }

  return {
    name,
    email,
  };
}

async function loadGitState(repoPath: string): Promise<LoadedGitState> {
  try {
    const repoRootPath = await resolveRepoRoot(repoPath);
    const [trackedPaths, { ignoredPaths, ignoredDirectoryPrefixes }] = await Promise.all([
      loadTrackedPaths(repoRootPath),
      loadIgnoredPaths(repoRootPath),
    ]);

    return {
      repoRootPath,
      ignoredDirectoryPrefixes,
      ignoredPaths,
      trackedPaths,
    };
  } catch {
    return {};
  }
}

function getGitTrackingState(relativePath: string, gitState: LoadedGitState): GitTrackingState {
  if (!gitState.trackedPaths) {
    return "unknown";
  }

  if (gitState.trackedPaths.has(relativePath)) {
    return "tracked";
  }

  if (
    gitState.ignoredPaths?.has(relativePath) ||
    gitState.ignoredDirectoryPrefixes?.some((prefix) => relativePath.startsWith(prefix))
  ) {
    return "ignored";
  }

  return "untracked";
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  return normalizePath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
}

async function loadTrackedPaths(repoRootPath: string): Promise<ReadonlySet<string>> {
  return new Set(loadNulSeparatedPaths(await runGit(repoRootPath, ["ls-files", "-z", "--cached"])));
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

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  return stdout;
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
        const nextPath = normalizePath(trimCommitToken(tokens[index + 2]));

        if (previousPath && nextPath) {
          files.push({
            addedLineCount,
            deletedLineCount,
            path: nextPath,
            previousPath,
            status: "R",
          });
        }

        index += 2;
        continue;
      }

      const filePath = normalizePath(inlinePath);

      if (filePath) {
        files.push({
          addedLineCount,
          deletedLineCount,
          path: filePath,
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

function joinRelativePath(left: string, right: string): string {
  return left ? `${left}/${right}` : right;
}

function normalizeDirectory(value: string): string {
  return value === "." ? "" : normalizePath(value);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}

function toRepositoryRelativePath(inputPath: string, repoPath: string): string {
  const absoluteInputPath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(repoPath, inputPath);
  const relativePath = path.relative(repoPath, absoluteInputPath);

  if (!relativePath || relativePath === ".") {
    return "";
  }

  return normalizePath(relativePath);
}
