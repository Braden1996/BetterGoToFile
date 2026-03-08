import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type RankingConfig } from "../config/schema";
import type { GitTrackingState } from "../workspace";

export interface SearchCandidate {
  readonly basename: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

export interface SearchContext<T extends SearchCandidate = SearchCandidate> {
  readonly activePath?: string;
  readonly openPaths?: ReadonlySet<string>;
  readonly getFrecencyScore?: (relativePath: string) => number;
  readonly getGitTrackingState?: (candidate: T) => GitTrackingState;
}

export interface ScoredSearchCandidate<T extends SearchCandidate = SearchCandidate> {
  readonly candidate: T;
  readonly lexical: number;
  readonly total: number;
}

export function rankSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
  ranking: RankingConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
): T[] {
  return scoreSearchCandidates(candidates, query, context, limit, ranking).map(
    ({ candidate }) => candidate,
  );
}

export function scoreSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
  ranking: RankingConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
): ScoredSearchCandidate<T>[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return candidates
      .map((candidate) => ({
        candidate,
        lexical: 0,
        total: computeContextBoost(candidate, context, false, ranking),
      }))
      .sort(
        (left, right) =>
          right.total - left.total || compareSearchCandidates(left.candidate, right.candidate),
      )
      .slice(0, limit);
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ranked = candidates.flatMap((candidate) => {
    const lexical = scoreCandidateLexical(candidate, tokens, ranking);

    if (lexical === null) {
      return [];
    }

    const total = lexical + computeContextBoost(candidate, context, true, ranking);

    return [{ candidate, lexical, total }];
  });

  return ranked
    .sort(
      (left, right) =>
        right.total - left.total ||
        right.lexical - left.lexical ||
        compareSearchCandidates(left.candidate, right.candidate),
    )
    .slice(0, limit);
}

export function compareSearchCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function scoreCandidateLexical(
  candidate: SearchCandidate,
  tokens: readonly string[],
  ranking: RankingConfig,
): number | null {
  let total = 0;

  for (const token of tokens) {
    const tokenScore = scoreToken(candidate, token, ranking);

    if (tokenScore === null) {
      return null;
    }

    total += tokenScore;
  }

  total -= candidate.relativePath.length * 0.15;

  return total;
}

function scoreToken(
  candidate: SearchCandidate,
  token: string,
  ranking: RankingConfig,
): number | null {
  const { lexical } = ranking;
  const expectsPath = token.includes("/") || token.includes("\\");

  if (candidate.searchBasename === token) {
    return lexical.basenameExactScore - candidate.basename.length;
  }

  if (candidate.searchPath === token) {
    return lexical.pathExactScore - candidate.relativePath.length;
  }

  if (expectsPath && candidate.searchPath.startsWith(token)) {
    return lexical.pathPrefixScore - candidate.relativePath.length;
  }

  if (candidate.searchBasename.startsWith(token)) {
    return lexical.basenamePrefixScore - candidate.basename.length;
  }

  const basenameBoundaryIndex = findBoundaryIndex(
    candidate.basename,
    candidate.searchBasename,
    token,
  );

  if (basenameBoundaryIndex >= 0) {
    return lexical.basenameBoundaryScore - basenameBoundaryIndex * 10 - candidate.basename.length;
  }

  const basenameIndex = candidate.searchBasename.indexOf(token);

  if (basenameIndex >= 0) {
    return lexical.basenameSubstringScore - basenameIndex * 8 - candidate.basename.length;
  }

  const pathBoundaryIndex = findBoundaryIndex(candidate.relativePath, candidate.searchPath, token);

  if (pathBoundaryIndex >= 0) {
    return lexical.pathBoundaryScore - pathBoundaryIndex * 4 - candidate.relativePath.length * 0.2;
  }

  const pathIndex = candidate.searchPath.indexOf(token);

  if (pathIndex >= 0) {
    return lexical.pathSubstringScore - pathIndex * 3 - candidate.relativePath.length * 0.1;
  }

  const basenameFuzzyScore = scoreFuzzyToken(token, candidate.basename, candidate.searchBasename);

  if (basenameFuzzyScore !== null) {
    return lexical.basenameFuzzyBonus + basenameFuzzyScore;
  }

  const pathFuzzyScore = scoreFuzzyToken(token, candidate.relativePath, candidate.searchPath);

  if (pathFuzzyScore !== null) {
    return lexical.pathFuzzyBonus + pathFuzzyScore;
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

function scoreFuzzyToken(token: string, original: string, lower: string): number | null {
  let cursor = 0;
  let previousIndex = -1;
  let streak = 0;
  let score = 0;

  for (const char of token) {
    const index = lower.indexOf(char, cursor);

    if (index === -1) {
      return null;
    }

    score += 24;

    if (previousIndex === -1) {
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

  return score;
}

function computeContextBoost<T extends SearchCandidate>(
  candidate: T,
  context: SearchContext<T>,
  hasQuery: boolean,
  ranking: RankingConfig,
): number {
  const { context: config } = ranking;
  let boost = 0;
  const frecencyScore = context.getFrecencyScore?.(candidate.relativePath) ?? 0;

  if (frecencyScore > 0) {
    boost += Math.round(
      Math.log2(1 + frecencyScore) *
        (hasQuery ? config.frecencyQueryMultiplier : config.frecencyBrowseMultiplier),
    );
  }

  const gitTrackingState = context.getGitTrackingState?.(candidate);

  if (gitTrackingState === "tracked") {
    boost += hasQuery ? config.trackedQueryBoost : config.trackedBrowseBoost;
  } else if (gitTrackingState === "ignored") {
    boost -= hasQuery ? config.ignoredQueryPenalty : config.ignoredBrowsePenalty;
  } else if (gitTrackingState === "untracked") {
    boost -= hasQuery ? config.untrackedQueryPenalty : config.untrackedBrowsePenalty;
  }

  if (context.openPaths?.has(candidate.relativePath)) {
    boost += hasQuery ? config.openQueryBoost : config.openBrowseBoost;
  }

  if (context.activePath === candidate.relativePath) {
    boost += hasQuery ? config.activeQueryBoost : config.activeBrowseBoost;
  }

  const activeDirectory = getDirectory(context.activePath);

  if (!activeDirectory || candidate.relativePath === context.activePath) {
    return boost;
  }

  if (candidate.directory === activeDirectory) {
    boost += hasQuery ? config.sameDirectoryQueryBoost : config.sameDirectoryBrowseBoost;
    return boost;
  }

  const sharedPrefixSegments = countSharedPrefixSegments(candidate.directory, activeDirectory);

  if (sharedPrefixSegments >= 2) {
    boost +=
      sharedPrefixSegments *
      (hasQuery ? config.sharedPrefixSegmentQueryBoost : config.sharedPrefixSegmentBrowseBoost);
  } else if (sharedPrefixSegments === 1) {
    boost += hasQuery ? config.sharedPrefixSingleQueryBoost : config.sharedPrefixSingleBrowseBoost;
  }

  return boost;
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

function countSharedPrefixSegments(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftSegments = left.split("/").filter(Boolean);
  const rightSegments = right.split("/").filter(Boolean);
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
