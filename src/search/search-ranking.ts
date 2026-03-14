import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type RankingConfig } from "../config/schema";
import type { GitTrackingState } from "../workspace";

const AMBIGUITY_CANDIDATE_COUNT_CAP = 500;
const GIT_PRIOR_SCORE_SCALE = 600;
const SHORT_QUERY_FRECENCY_TRANSITION_LENGTH = 3;

export interface SearchCandidate {
  readonly basename: string;
  readonly relativePath: string;
  readonly identityPath?: string;
  readonly directory: string;
  readonly packageRoot?: string;
  readonly packageRootIdentity?: string;
  readonly workspaceFolderPath?: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

export interface SearchContext<T extends SearchCandidate = SearchCandidate> {
  readonly activePath?: string;
  readonly activeIdentityPath?: string;
  readonly activePackageRoot?: string;
  readonly activePackageRootIdentity?: string;
  readonly activeWorkspaceFolderPath?: string;
  readonly openPaths?: ReadonlySet<string>;
  readonly openIdentityPaths?: ReadonlySet<string>;
  readonly getFrecencyScore?: (relativePath: string) => number;
  readonly getGitPrior?: (candidate: T) => number;
  readonly getGitTrackingState?: (candidate: T) => GitTrackingState;
}

export type TokenMatchKind =
  | "basenameExact"
  | "pathExact"
  | "pathPrefix"
  | "pathBoundary"
  | "pathSubstring"
  | "basenamePrefix"
  | "basenameBoundary"
  | "basenameSubstring"
  | "packageExact"
  | "packagePrefix"
  | "packageBoundary"
  | "packageSubstring"
  | "basenameFuzzy"
  | "packageFuzzy"
  | "pathFuzzy";

interface TokenScoreBreakdown {
  readonly token: string;
  readonly kind: TokenMatchKind;
  readonly score: number;
}

interface ScoreContribution {
  readonly label: string;
  readonly score: number;
}

export interface LexicalScoreBreakdown {
  readonly total: number;
  readonly tokenMatches: readonly TokenScoreBreakdown[];
  readonly queryStructureBonus: number;
  readonly pathLengthPenalty: number;
}

export interface ContextScoreBreakdown {
  readonly total: number;
  readonly contributions: readonly ScoreContribution[];
}

export interface GitPriorScoreBreakdown {
  readonly total: number;
  readonly rawPrior: number;
  readonly ambiguity: number;
}

export interface SearchScoreBreakdown {
  readonly lexical: LexicalScoreBreakdown;
  readonly context: ContextScoreBreakdown;
  readonly gitPrior: GitPriorScoreBreakdown;
}

interface ScoredSearchCandidate<T extends SearchCandidate = SearchCandidate> {
  readonly candidate: T;
  readonly lexical: number;
  readonly total: number;
  readonly breakdown: SearchScoreBreakdown;
}

interface RankedSearchCandidatesResult<T extends SearchCandidate = SearchCandidate> {
  readonly rankedCandidates: readonly T[];
  readonly matchedCandidates: readonly T[];
}

type TokenMatchRegion = "basename" | "package" | "path";

interface TokenMatch {
  readonly token: string;
  readonly kind: TokenMatchKind;
  readonly score: number;
  readonly pathIndex: number;
  readonly segmentIndex: number;
  readonly region: TokenMatchRegion;
}

interface FuzzyMatch {
  readonly score: number;
  readonly startIndex: number;
}

interface PackageRootMatchTarget {
  readonly originalBasename: string;
  readonly searchBasename: string;
  readonly pathIndex: number;
  readonly segmentIndex: number;
}

interface RankedSearchCandidate<T extends SearchCandidate = SearchCandidate> {
  readonly candidate: T;
  readonly lexical: number;
  readonly total: number;
}

interface TokenMatchSummary {
  readonly segmentIndex: number;
  readonly region: TokenMatchRegion;
}

const packageRootMatchTargetCache = new WeakMap<SearchCandidate, PackageRootMatchTarget | null>();
const directorySegmentsCache = new Map<string, readonly string[]>();

export function rankSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
  ranking: RankingConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
): T[] {
  return collectRankedSearchCandidates(
    candidates,
    query,
    context,
    limit,
    ranking,
  ).rankedCandidates.slice();
}

export function collectRankedSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
  ranking: RankingConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
): RankedSearchCandidatesResult<T> {
  const normalizedQuery = query.trim().toLowerCase();
  const queryStrength = computeQueryStrength(normalizedQuery);
  const activeDirectory = getDirectory(context.activePath);

  if (!normalizedQuery) {
    const ranked: RankedSearchCandidate<T>[] = [];

    for (const candidate of candidates) {
      insertRankedCandidate(
        ranked,
        {
          candidate,
          lexical: 0,
          total: computeContextScore(candidate, context, activeDirectory, queryStrength, ranking),
        },
        limit,
      );
    }

    return {
      rankedCandidates: ranked.map(({ candidate }) => candidate),
      matchedCandidates: candidates,
    };
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const lexicalMatches: { candidate: T; lexical: number }[] = [];

  for (const candidate of candidates) {
    const lexical = scoreCandidateLexicalTotal(candidate, tokens, ranking);

    if (lexical !== null) {
      lexicalMatches.push({ candidate, lexical });
    }
  }

  const ambiguity = computeAmbiguity(lexicalMatches.length);
  const ranked: RankedSearchCandidate<T>[] = [];

  for (const { candidate, lexical } of lexicalMatches) {
    insertRankedCandidate(
      ranked,
      {
        candidate,
        lexical,
        total:
          lexical +
          computeContextScore(candidate, context, activeDirectory, queryStrength, ranking) +
          computeGitPriorScore(candidate, context, ambiguity * queryStrength),
      },
      limit,
    );
  }

  return {
    rankedCandidates: ranked.map(({ candidate }) => candidate),
    matchedCandidates: lexicalMatches.map(({ candidate }) => candidate),
  };
}

export function scoreSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
  ranking: RankingConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
): ScoredSearchCandidate<T>[] {
  const normalizedQuery = query.trim().toLowerCase();
  const queryStrength = computeQueryStrength(normalizedQuery);
  const activeDirectory = getDirectory(context.activePath);

  if (!normalizedQuery) {
    const ranked: ScoredSearchCandidate<T>[] = [];

    for (const candidate of candidates) {
      const lexicalBreakdown = createEmptyLexicalScoreBreakdown();
      const contextBreakdown = computeContextBreakdown(
        candidate,
        context,
        activeDirectory,
        queryStrength,
        ranking,
      );
      const gitPriorBreakdown = computeGitPriorBreakdown(candidate, context, 0);

      insertRankedCandidate(
        ranked,
        {
          candidate,
          lexical: 0,
          total: contextBreakdown.total + gitPriorBreakdown.total,
          breakdown: {
            lexical: lexicalBreakdown,
            context: contextBreakdown,
            gitPrior: gitPriorBreakdown,
          },
        },
        limit,
      );
    }

    return ranked;
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const lexicalMatches: { candidate: T; lexicalBreakdown: LexicalScoreBreakdown }[] = [];

  for (const candidate of candidates) {
    const lexicalBreakdown = scoreCandidateLexical(candidate, tokens, ranking);

    if (lexicalBreakdown === null) {
      continue;
    }

    lexicalMatches.push({ candidate, lexicalBreakdown });
  }

  const ambiguity = computeAmbiguity(lexicalMatches.length);
  const topRanked: ScoredSearchCandidate<T>[] = [];

  for (const { candidate, lexicalBreakdown } of lexicalMatches) {
    const contextBreakdown = computeContextBreakdown(
      candidate,
      context,
      activeDirectory,
      queryStrength,
      ranking,
    );
    const gitPriorBreakdown = computeGitPriorBreakdown(
      candidate,
      context,
      ambiguity * queryStrength,
    );
    const lexical = lexicalBreakdown.total;

    insertRankedCandidate(
      topRanked,
      {
        candidate,
        lexical,
        total: lexical + contextBreakdown.total + gitPriorBreakdown.total,
        breakdown: {
          lexical: lexicalBreakdown,
          context: contextBreakdown,
          gitPrior: gitPriorBreakdown,
        },
      },
      limit,
    );
  }

  return topRanked;
}

function computeAmbiguity(candidateCount: number): number {
  if (candidateCount <= 0) {
    return 0;
  }

  return clamp(Math.log1p(candidateCount) / Math.log1p(AMBIGUITY_CANDIDATE_COUNT_CAP), 0, 1);
}

function compareSearchCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath) ||
    getCandidateIdentity(left).localeCompare(getCandidateIdentity(right))
  );
}

function scoreCandidateLexical(
  candidate: SearchCandidate,
  tokens: readonly string[],
  ranking: RankingConfig,
): LexicalScoreBreakdown | null {
  let total = 0;
  const matches: TokenMatch[] = [];
  const packageRootTarget = getPackageRootMatchTarget(candidate);

  for (const token of tokens) {
    const tokenMatch = scoreToken(candidate, token, ranking, packageRootTarget);

    if (tokenMatch === null) {
      return null;
    }

    total += tokenMatch.score;
    matches.push(tokenMatch);
  }

  const queryStructureBonus = computeQueryStructureBonus(matches, ranking);
  const pathLengthPenalty = candidate.relativePath.length * 0.08;

  total += queryStructureBonus;
  total -= pathLengthPenalty;

  return {
    total,
    tokenMatches: matches.map(({ token, kind, score }) => ({
      token,
      kind,
      score,
    })),
    queryStructureBonus,
    pathLengthPenalty,
  };
}

function scoreCandidateLexicalTotal(
  candidate: SearchCandidate,
  tokens: readonly string[],
  ranking: RankingConfig,
): number | null {
  let total = 0;
  const matches: TokenMatchSummary[] = [];
  const packageRootTarget = getPackageRootMatchTarget(candidate);

  for (const token of tokens) {
    const tokenMatch = scoreToken(candidate, token, ranking, packageRootTarget);

    if (tokenMatch === null) {
      return null;
    }

    total += tokenMatch.score;
    matches.push({
      segmentIndex: tokenMatch.segmentIndex,
      region: tokenMatch.region,
    });
  }

  total += computeQueryStructureBonusFromSummaries(matches, ranking);
  total -= candidate.relativePath.length * 0.08;

  return total;
}

function scoreToken(
  candidate: SearchCandidate,
  token: string,
  ranking: RankingConfig,
  packageRootTarget: PackageRootMatchTarget | undefined,
): TokenMatch | null {
  const { lexical } = ranking;
  const expectsPath = token.includes("/") || token.includes("\\");
  const basenamePathIndex = candidate.relativePath.length - candidate.basename.length;

  if (candidate.searchBasename === token) {
    return createTokenMatch(
      token,
      "basenameExact",
      lexical.basenameExactScore - candidate.basename.length,
      basenamePathIndex,
      candidate.searchPath,
      "basename",
    );
  }

  if (candidate.searchPath === token) {
    return createTokenMatch(
      token,
      "pathExact",
      lexical.pathExactScore - candidate.relativePath.length,
      0,
      candidate.searchPath,
      "path",
    );
  }

  if (expectsPath && candidate.searchPath.startsWith(token)) {
    return createTokenMatch(
      token,
      "pathPrefix",
      lexical.pathPrefixScore - candidate.relativePath.length,
      0,
      candidate.searchPath,
      "path",
    );
  }

  if (candidate.searchBasename.startsWith(token)) {
    return createTokenMatch(
      token,
      "basenamePrefix",
      lexical.basenamePrefixScore - candidate.basename.length,
      basenamePathIndex,
      candidate.searchPath,
      "basename",
    );
  }

  const basenameBoundaryIndex = findBoundaryIndex(
    candidate.basename,
    candidate.searchBasename,
    token,
  );

  if (basenameBoundaryIndex >= 0) {
    return createTokenMatch(
      token,
      "basenameBoundary",
      lexical.basenameBoundaryScore - basenameBoundaryIndex * 6 - candidate.basename.length,
      basenamePathIndex + basenameBoundaryIndex,
      candidate.searchPath,
      "basename",
    );
  }

  const basenameIndex = candidate.searchBasename.indexOf(token);

  if (basenameIndex >= 0) {
    return createTokenMatch(
      token,
      "basenameSubstring",
      lexical.basenameSubstringScore - basenameIndex * 8 - candidate.basename.length,
      basenamePathIndex + basenameIndex,
      candidate.searchPath,
      "basename",
    );
  }

  const packageRootMatch = packageRootTarget
    ? scorePackageRootToken(token, packageRootTarget, ranking)
    : null;

  if (packageRootMatch) {
    return packageRootMatch;
  }

  const pathBoundaryIndex = findBoundaryIndex(candidate.relativePath, candidate.searchPath, token);

  if (pathBoundaryIndex >= 0) {
    return createTokenMatch(
      token,
      "pathBoundary",
      lexical.pathBoundaryScore - pathBoundaryIndex * 4 - candidate.relativePath.length * 0.2,
      pathBoundaryIndex,
      candidate.searchPath,
      "path",
    );
  }

  const pathIndex = candidate.searchPath.indexOf(token);

  if (pathIndex >= 0) {
    return createTokenMatch(
      token,
      "pathSubstring",
      lexical.pathSubstringScore - pathIndex * 3 - candidate.relativePath.length * 0.1,
      pathIndex,
      candidate.searchPath,
      "path",
    );
  }

  const basenameFuzzyScore = scoreFuzzyToken(token, candidate.basename, candidate.searchBasename);

  if (basenameFuzzyScore !== null) {
    return createTokenMatch(
      token,
      "basenameFuzzy",
      lexical.basenameFuzzyBonus + basenameFuzzyScore.score,
      basenamePathIndex + basenameFuzzyScore.startIndex,
      candidate.searchPath,
      "basename",
    );
  }

  const packageRootFuzzyMatch = packageRootTarget
    ? scorePackageRootFuzzyToken(token, packageRootTarget, ranking)
    : null;

  if (packageRootFuzzyMatch) {
    return packageRootFuzzyMatch;
  }

  const pathFuzzyScore = scoreFuzzyToken(token, candidate.relativePath, candidate.searchPath);

  if (pathFuzzyScore !== null) {
    return createTokenMatch(
      token,
      "pathFuzzy",
      lexical.pathFuzzyBonus + pathFuzzyScore.score,
      pathFuzzyScore.startIndex,
      candidate.searchPath,
      "path",
    );
  }

  return null;
}

function findBoundaryIndex(original: string, lower: string, token: string): number {
  for (let index = lower.indexOf(token); index >= 0; index = lower.indexOf(token, index + 1)) {
    if (isBoundary(original, index)) {
      return index;
    }
  }

  return -1;
}

function scoreFuzzyToken(token: string, original: string, lower: string): FuzzyMatch | null {
  let cursor = 0;
  let previousIndex = -1;
  let streak = 0;
  let score = 0;
  let startIndex = -1;

  for (const char of token) {
    const index = lower.indexOf(char, cursor);

    if (index === -1) {
      return null;
    }

    score += 24;

    if (previousIndex === -1) {
      startIndex = index;
      score -= index * 3;

      if (index === 0) {
        score += 18;
      }
    } else {
      const gap = index - previousIndex - 1;

      if (gap === 0) {
        streak += 1;
        score += 18 + Math.min(streak, 4) * 6;
      } else {
        streak = 0;
        score -= gap * 4;
      }
    }

    if (isBoundary(original, index)) {
      score += 16;
    }

    if (index === lower.length - 1) {
      score += 4;
    }

    previousIndex = index;
    cursor = index + 1;
  }

  score -= Math.max(0, lower.length - token.length);

  return {
    score,
    startIndex,
  };
}

function computeContextBreakdown<T extends SearchCandidate>(
  candidate: T,
  context: SearchContext<T>,
  activeDirectory: string | undefined,
  queryStrength: number,
  ranking: RankingConfig,
): ContextScoreBreakdown {
  const { context: config } = ranking;
  const contributions: ScoreContribution[] = [];
  const activePackageRootIdentity = context.activePackageRootIdentity ?? context.activePackageRoot;
  const candidateIdentity = getCandidateIdentity(candidate);
  const candidatePackageRootIdentity = getCandidatePackageRootIdentity(candidate);
  const frecencyScore = context.getFrecencyScore?.(candidateIdentity) ?? 0;
  const addContribution = (label: string, score: number): void => {
    if (score !== 0) {
      contributions.push({ label, score });
    }
  };

  if (frecencyScore > 0) {
    addContribution(
      "frecency",
      Math.round(
        Math.log2(1 + frecencyScore) *
          interpolateScore(
            config.frecencyBrowseMultiplier,
            config.frecencyQueryMultiplier,
            queryStrength,
          ),
      ),
    );
  }

  const gitTrackingState = context.getGitTrackingState?.(candidate);

  if (gitTrackingState === "tracked") {
    addContribution("tracked", Math.round(config.trackedQueryBoost * queryStrength));
  } else if (gitTrackingState === "ignored") {
    addContribution("ignored", -Math.round(config.ignoredQueryPenalty * queryStrength));
  } else if (gitTrackingState === "untracked") {
    addContribution("untracked", -Math.round(config.untrackedQueryPenalty * queryStrength));
  }

  if (
    context.openIdentityPaths?.has(candidateIdentity) ||
    context.openPaths?.has(candidate.relativePath)
  ) {
    addContribution("open", Math.round(config.openQueryBoost * queryStrength));
  }

  if (
    context.activeIdentityPath === candidateIdentity ||
    (!context.activeIdentityPath && context.activePath === candidate.relativePath)
  ) {
    addContribution("active", Math.round(config.activeQueryBoost * queryStrength));
  }

  if (
    activePackageRootIdentity !== undefined &&
    candidatePackageRootIdentity !== undefined &&
    activePackageRootIdentity === candidatePackageRootIdentity &&
    candidateIdentity !== context.activeIdentityPath &&
    (!context.activeIdentityPath || candidate.relativePath !== context.activePath)
  ) {
    addContribution("same-pkg", Math.round(computeSamePackageBoost(config) * queryStrength));
  }

  if (
    !activeDirectory ||
    candidateIdentity === context.activeIdentityPath ||
    (!context.activeIdentityPath && candidate.relativePath === context.activePath)
  ) {
    return finalizeContextScoreBreakdown(contributions);
  }

  if (
    context.activeWorkspaceFolderPath &&
    candidate.workspaceFolderPath &&
    context.activeWorkspaceFolderPath !== candidate.workspaceFolderPath
  ) {
    return finalizeContextScoreBreakdown(contributions);
  }

  if (candidate.directory === activeDirectory) {
    addContribution("same-dir", Math.round(config.sameDirectoryQueryBoost * queryStrength));
    return finalizeContextScoreBreakdown(contributions);
  }

  const sharedPrefixSegments = countSharedPrefixSegments(candidate.directory, activeDirectory);

  if (sharedPrefixSegments >= 2) {
    addContribution(
      `shared-prefix x${sharedPrefixSegments}`,
      Math.round(sharedPrefixSegments * config.sharedPrefixSegmentQueryBoost * queryStrength),
    );
  } else if (sharedPrefixSegments === 1) {
    addContribution(
      "shared-prefix",
      Math.round(config.sharedPrefixSingleQueryBoost * queryStrength),
    );
  }

  return finalizeContextScoreBreakdown(contributions);
}

function computeContextScore<T extends SearchCandidate>(
  candidate: T,
  context: SearchContext<T>,
  activeDirectory: string | undefined,
  queryStrength: number,
  ranking: RankingConfig,
): number {
  const { context: config } = ranking;
  const activePackageRootIdentity = context.activePackageRootIdentity ?? context.activePackageRoot;
  const candidateIdentity = getCandidateIdentity(candidate);
  const candidatePackageRootIdentity = getCandidatePackageRootIdentity(candidate);
  let total = 0;
  const frecencyScore = context.getFrecencyScore?.(candidateIdentity) ?? 0;

  if (frecencyScore > 0) {
    total += Math.round(
      Math.log2(1 + frecencyScore) *
        interpolateScore(
          config.frecencyBrowseMultiplier,
          config.frecencyQueryMultiplier,
          queryStrength,
        ),
    );
  }

  const gitTrackingState = context.getGitTrackingState?.(candidate);

  if (gitTrackingState === "tracked") {
    total += Math.round(config.trackedQueryBoost * queryStrength);
  } else if (gitTrackingState === "ignored") {
    total -= Math.round(config.ignoredQueryPenalty * queryStrength);
  } else if (gitTrackingState === "untracked") {
    total -= Math.round(config.untrackedQueryPenalty * queryStrength);
  }

  if (
    context.openIdentityPaths?.has(candidateIdentity) ||
    context.openPaths?.has(candidate.relativePath)
  ) {
    total += Math.round(config.openQueryBoost * queryStrength);
  }

  if (
    context.activeIdentityPath === candidateIdentity ||
    (!context.activeIdentityPath && context.activePath === candidate.relativePath)
  ) {
    total += Math.round(config.activeQueryBoost * queryStrength);
  }

  if (
    activePackageRootIdentity !== undefined &&
    candidatePackageRootIdentity !== undefined &&
    activePackageRootIdentity === candidatePackageRootIdentity &&
    candidateIdentity !== context.activeIdentityPath &&
    (!context.activeIdentityPath || candidate.relativePath !== context.activePath)
  ) {
    total += Math.round(computeSamePackageBoost(config) * queryStrength);
  }

  if (
    !activeDirectory ||
    candidateIdentity === context.activeIdentityPath ||
    (!context.activeIdentityPath && candidate.relativePath === context.activePath)
  ) {
    return total;
  }

  if (
    context.activeWorkspaceFolderPath &&
    candidate.workspaceFolderPath &&
    context.activeWorkspaceFolderPath !== candidate.workspaceFolderPath
  ) {
    return total;
  }

  if (candidate.directory === activeDirectory) {
    return total + Math.round(config.sameDirectoryQueryBoost * queryStrength);
  }

  const sharedPrefixSegments = countSharedPrefixSegments(candidate.directory, activeDirectory);

  if (sharedPrefixSegments >= 2) {
    return (
      total +
      Math.round(sharedPrefixSegments * config.sharedPrefixSegmentQueryBoost * queryStrength)
    );
  }

  if (sharedPrefixSegments === 1) {
    return total + Math.round(config.sharedPrefixSingleQueryBoost * queryStrength);
  }

  return total;
}

function getDirectory(relativePath?: string): string | undefined {
  if (!relativePath) {
    return undefined;
  }

  const segments = relativePath.split("/");

  segments.pop();

  const directory = segments.join("/");

  return directory || undefined;
}

function getCandidateIdentity(candidate: SearchCandidate): string {
  return candidate.identityPath ?? candidate.relativePath;
}

function getCandidatePackageRootIdentity(candidate: SearchCandidate): string | undefined {
  return candidate.packageRootIdentity ?? candidate.packageRoot;
}

function countSharedPrefixSegments(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftSegments = getDirectorySegments(left);
  const rightSegments = getDirectorySegments(right);
  const count = Math.min(leftSegments.length, rightSegments.length);
  let shared = 0;

  for (let index = 0; index < count; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) {
      break;
    }

    shared += 1;
  }

  return shared;
}

function getPackageRootMatchTarget(candidate: SearchCandidate): PackageRootMatchTarget | undefined {
  const cachedTarget = packageRootMatchTargetCache.get(candidate);

  if (cachedTarget !== undefined) {
    return cachedTarget ?? undefined;
  }

  if (!candidate.packageRoot) {
    packageRootMatchTargetCache.set(candidate, null);
    return undefined;
  }

  const separatorIndex = candidate.packageRoot.lastIndexOf("/");
  const originalBasename =
    separatorIndex >= 0 ? candidate.packageRoot.slice(separatorIndex + 1) : candidate.packageRoot;

  if (!originalBasename) {
    packageRootMatchTargetCache.set(candidate, null);
    return undefined;
  }

  const searchBasename = originalBasename.toLowerCase();
  const pathIndex = candidate.packageRoot.length - originalBasename.length;
  const target = {
    originalBasename,
    searchBasename,
    pathIndex,
    segmentIndex: countSegmentIndexAtPathIndex(candidate.searchPath, pathIndex),
  };

  packageRootMatchTargetCache.set(candidate, target);
  return target;
}

function scorePackageRootToken(
  token: string,
  target: PackageRootMatchTarget,
  ranking: RankingConfig,
): TokenMatch | null {
  const { lexical } = ranking;

  if (target.searchBasename === token) {
    return createTokenMatch(
      token,
      "packageExact",
      interpolateScore(lexical.pathExactScore, lexical.basenameExactScore, 0.72) -
        target.originalBasename.length,
      target.pathIndex,
      target.searchBasename,
      "package",
      target.segmentIndex,
    );
  }

  if (target.searchBasename.startsWith(token)) {
    return createTokenMatch(
      token,
      "packagePrefix",
      interpolateScore(lexical.pathPrefixScore, lexical.basenamePrefixScore, 0.72) -
        target.originalBasename.length,
      target.pathIndex,
      target.searchBasename,
      "package",
      target.segmentIndex,
    );
  }

  const boundaryIndex = findBoundaryIndex(target.originalBasename, target.searchBasename, token);

  if (boundaryIndex >= 0) {
    return createTokenMatch(
      token,
      "packageBoundary",
      interpolateScore(lexical.pathBoundaryScore, lexical.basenameBoundaryScore, 0.68) -
        boundaryIndex * 9 -
        target.originalBasename.length,
      target.pathIndex + boundaryIndex,
      target.searchBasename,
      "package",
      target.segmentIndex,
    );
  }

  const substringIndex = target.searchBasename.indexOf(token);

  if (substringIndex >= 0) {
    return createTokenMatch(
      token,
      "packageSubstring",
      interpolateScore(lexical.pathSubstringScore, lexical.basenameSubstringScore, 0.62) -
        substringIndex * 7 -
        target.originalBasename.length,
      target.pathIndex + substringIndex,
      target.searchBasename,
      "package",
      target.segmentIndex,
    );
  }

  return null;
}

function scorePackageRootFuzzyToken(
  token: string,
  target: PackageRootMatchTarget,
  ranking: RankingConfig,
): TokenMatch | null {
  const fuzzyMatch = scoreFuzzyToken(token, target.originalBasename, target.searchBasename);

  if (!fuzzyMatch) {
    return null;
  }

  return createTokenMatch(
    token,
    "packageFuzzy",
    interpolateScore(ranking.lexical.pathFuzzyBonus, ranking.lexical.basenameFuzzyBonus, 0.45) +
      fuzzyMatch.score,
    target.pathIndex + fuzzyMatch.startIndex,
    target.searchBasename,
    "package",
    target.segmentIndex,
  );
}

function computeQueryStructureBonus(
  matches: readonly TokenMatch[],
  ranking: RankingConfig,
): number {
  return computeQueryStructureBonusFromSummaries(matches, ranking);
}

function computeQueryStructureBonusFromSummaries(
  matches: readonly TokenMatchSummary[],
  ranking: RankingConfig,
): number {
  if (matches.length < 2) {
    return 0;
  }

  let bonus =
    Math.max(0, new Set(matches.map((match) => match.segmentIndex)).size - 1) *
    Math.max(56, ranking.lexical.pathBoundaryScore * 0.04);

  for (let index = 1; index < matches.length; index += 1) {
    const gap = matches[index].segmentIndex - matches[index - 1].segmentIndex;

    if (gap <= 0) {
      continue;
    }

    bonus += Math.max(42, ranking.lexical.pathBoundaryScore * 0.03);
    bonus += Math.max(
      0,
      Math.max(20, ranking.lexical.pathBoundaryScore * 0.025) - Math.max(0, gap - 1) * 16,
    );
  }

  if (
    matches.some((match) => match.region === "package") &&
    matches.some((match) => match.region === "basename")
  ) {
    bonus += Math.max(160, ranking.lexical.basenameBoundaryScore * 0.08);
  }

  return bonus;
}

function getDirectorySegments(directory: string): readonly string[] {
  const cachedSegments = directorySegmentsCache.get(directory);

  if (cachedSegments) {
    return cachedSegments;
  }

  const segments = directory.split("/").filter(Boolean);

  directorySegmentsCache.set(directory, segments);
  return segments;
}

function createTokenMatch(
  token: string,
  kind: TokenMatchKind,
  score: number,
  pathIndex: number,
  path: string,
  region: TokenMatchRegion,
  segmentIndex = countSegmentIndexAtPathIndex(path, pathIndex),
): TokenMatch {
  return {
    token,
    kind,
    score,
    pathIndex,
    segmentIndex,
    region,
  };
}

function createEmptyLexicalScoreBreakdown(): LexicalScoreBreakdown {
  return {
    total: 0,
    tokenMatches: [],
    queryStructureBonus: 0,
    pathLengthPenalty: 0,
  };
}

function finalizeContextScoreBreakdown(
  contributions: readonly ScoreContribution[],
): ContextScoreBreakdown {
  return {
    total: contributions.reduce((total, contribution) => total + contribution.score, 0),
    contributions,
  };
}

function countSegmentIndexAtPathIndex(path: string, index: number): number {
  let segmentIndex = 0;

  for (let cursor = 0; cursor < index && cursor < path.length; cursor += 1) {
    if (path[cursor] === "/" || path[cursor] === "\\") {
      segmentIndex += 1;
    }
  }

  return segmentIndex;
}

function interpolateScore(minimum: number, maximum: number, weight: number): number {
  return minimum + (maximum - minimum) * weight;
}

function computeSamePackageBoost(config: RankingConfig["context"]): number {
  return config.sameDirectoryQueryBoost + config.sharedPrefixSegmentQueryBoost * 3;
}

function isBoundary(value: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = value[index - 1];
  const current = value[index];

  return isSeparator(previous) || isCamelCaseBoundary(previous, current);
}

function isSeparator(char: string): boolean {
  return (
    char === "/" || char === "\\" || char === "-" || char === "_" || char === "." || char === " "
  );
}

function isCamelCaseBoundary(previous: string, current: string): boolean {
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(current);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeQueryStrength(normalizedQuery: string): number {
  const queryLength = normalizedQuery.replace(/\s+/g, "").length;

  return clamp(queryLength / SHORT_QUERY_FRECENCY_TRANSITION_LENGTH, 0, 1);
}

function computeGitPriorScore<T extends SearchCandidate>(
  candidate: T,
  context: SearchContext<T>,
  ambiguity: number,
): number {
  if (ambiguity <= 0) {
    return 0;
  }

  const rawPrior = context.getGitPrior?.(candidate) ?? 0;

  return rawPrior > 0 ? Math.log1p(rawPrior) * GIT_PRIOR_SCORE_SCALE * ambiguity : 0;
}

function insertRankedCandidate<T extends SearchCandidate, U extends RankedSearchCandidate<T>>(
  ranked: U[],
  candidate: U,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  let index = ranked.length;

  while (index > 0 && compareRankedSearchCandidates(candidate, ranked[index - 1]) < 0) {
    index -= 1;
  }

  if (index >= limit) {
    return;
  }

  ranked.splice(index, 0, candidate);

  if (ranked.length > limit) {
    ranked.pop();
  }
}

function compareRankedSearchCandidates<
  T extends SearchCandidate,
  U extends RankedSearchCandidate<T>,
>(left: U, right: U): number {
  return (
    right.total - left.total ||
    right.lexical - left.lexical ||
    compareSearchCandidates(left.candidate, right.candidate)
  );
}

function computeGitPriorBreakdown<T extends SearchCandidate>(
  candidate: T,
  context: SearchContext<T>,
  ambiguity: number,
): GitPriorScoreBreakdown {
  const rawPrior = ambiguity > 0 ? (context.getGitPrior?.(candidate) ?? 0) : 0;

  return {
    total: computeGitPriorScore(candidate, context, ambiguity),
    rawPrior,
    ambiguity: ambiguity > 0 ? ambiguity : 0,
  };
}
