export interface SearchCandidate {
  readonly basename: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

export type GitTrackingState = "tracked" | "untracked" | "ignored" | "unknown";

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

const BASENAME_EXACT_SCORE = 5600;
const PATH_EXACT_SCORE = 5200;
const BASENAME_PREFIX_SCORE = 4700;
const PATH_PREFIX_SCORE = 4300;
const BASENAME_BOUNDARY_SCORE = 3900;
const PATH_BOUNDARY_SCORE = 3200;
const BASENAME_SUBSTRING_SCORE = 3000;
const PATH_SUBSTRING_SCORE = 2500;
const BASENAME_FUZZY_BONUS = 1800;
const PATH_FUZZY_BONUS = 900;

export function rankSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
): T[] {
  return scoreSearchCandidates(candidates, query, context, limit).map(({ candidate }) => candidate);
}

export function scoreSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  context: SearchContext<T> = {},
  limit = 200,
): ScoredSearchCandidate<T>[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return candidates
      .map((candidate) => ({
        candidate,
        lexical: 0,
        total: computeContextBoost(candidate, context, false),
      }))
      .sort(
        (left, right) =>
          right.total - left.total || compareSearchCandidates(left.candidate, right.candidate),
      )
      .slice(0, limit);
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ranked = candidates.flatMap((candidate) => {
    const lexical = scoreCandidateLexical(candidate, tokens);

    if (lexical === null) {
      return [];
    }

    const total = lexical + computeContextBoost(candidate, context, true);

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
): number | null {
  let total = 0;

  for (const token of tokens) {
    const tokenScore = scoreToken(candidate, token);

    if (tokenScore === null) {
      return null;
    }

    total += tokenScore;
  }

  total -= candidate.relativePath.length * 0.15;

  return total;
}

function scoreToken(candidate: SearchCandidate, token: string): number | null {
  const expectsPath = token.includes("/") || token.includes("\\");

  if (candidate.searchBasename === token) {
    return BASENAME_EXACT_SCORE - candidate.basename.length;
  }

  if (candidate.searchPath === token) {
    return PATH_EXACT_SCORE - candidate.relativePath.length;
  }

  if (expectsPath && candidate.searchPath.startsWith(token)) {
    return PATH_PREFIX_SCORE - candidate.relativePath.length;
  }

  if (candidate.searchBasename.startsWith(token)) {
    return BASENAME_PREFIX_SCORE - candidate.basename.length;
  }

  const basenameBoundaryIndex = findBoundaryIndex(
    candidate.basename,
    candidate.searchBasename,
    token,
  );

  if (basenameBoundaryIndex >= 0) {
    return BASENAME_BOUNDARY_SCORE - basenameBoundaryIndex * 10 - candidate.basename.length;
  }

  const basenameIndex = candidate.searchBasename.indexOf(token);

  if (basenameIndex >= 0) {
    return BASENAME_SUBSTRING_SCORE - basenameIndex * 8 - candidate.basename.length;
  }

  const pathBoundaryIndex = findBoundaryIndex(candidate.relativePath, candidate.searchPath, token);

  if (pathBoundaryIndex >= 0) {
    return PATH_BOUNDARY_SCORE - pathBoundaryIndex * 4 - candidate.relativePath.length * 0.2;
  }

  const pathIndex = candidate.searchPath.indexOf(token);

  if (pathIndex >= 0) {
    return PATH_SUBSTRING_SCORE - pathIndex * 3 - candidate.relativePath.length * 0.1;
  }

  const basenameFuzzyScore = scoreFuzzyToken(token, candidate.basename, candidate.searchBasename);

  if (basenameFuzzyScore !== null) {
    return BASENAME_FUZZY_BONUS + basenameFuzzyScore;
  }

  const pathFuzzyScore = scoreFuzzyToken(token, candidate.relativePath, candidate.searchPath);

  if (pathFuzzyScore !== null) {
    return PATH_FUZZY_BONUS + pathFuzzyScore;
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
): number {
  let boost = 0;
  const frecencyScore = context.getFrecencyScore?.(candidate.relativePath) ?? 0;

  if (frecencyScore > 0) {
    boost += Math.round(Math.log2(1 + frecencyScore) * (hasQuery ? 140 : 240));
  }

  const gitTrackingState = context.getGitTrackingState?.(candidate);

  if (gitTrackingState === "tracked") {
    boost += hasQuery ? 120 : 240;
  } else if (gitTrackingState === "ignored") {
    boost -= hasQuery ? 1800 : 3000;
  } else if (gitTrackingState === "untracked") {
    boost -= hasQuery ? 1100 : 2200;
  }

  if (context.openPaths?.has(candidate.relativePath)) {
    boost += hasQuery ? 170 : 320;
  }

  if (context.activePath === candidate.relativePath) {
    boost += hasQuery ? 120 : 260;
  }

  const activeDirectory = getDirectory(context.activePath);

  if (!activeDirectory || candidate.relativePath === context.activePath) {
    return boost;
  }

  if (candidate.directory === activeDirectory) {
    boost += hasQuery ? 110 : 210;
    return boost;
  }

  const sharedPrefixSegments = countSharedPrefixSegments(candidate.directory, activeDirectory);

  if (sharedPrefixSegments >= 2) {
    boost += sharedPrefixSegments * (hasQuery ? 40 : 70);
  } else if (sharedPrefixSegments === 1) {
    boost += hasQuery ? 24 : 44;
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
