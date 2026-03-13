export type PathGlobMatcher = (relativePath: string) => boolean;

export function createPathGlobMatcher(pattern: string): PathGlobMatcher {
  const normalizedPattern = normalizeGlobPattern(pattern);
  const patternSegments = splitPattern(normalizedPattern);
  const segmentPatterns = new Map<string, RegExp>();

  return (relativePath: string): boolean => {
    const normalizedPath = normalizeGlobPath(relativePath);

    return matchSegments(patternSegments, splitPattern(normalizedPath), segmentPatterns, 0, 0);
  };
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = normalizeGlobPath(pattern).replace(/^\/+|\/+$/g, "");

  return normalized || "**/*";
}

function splitPattern(value: string): string[] {
  return value ? value.split("/").filter(Boolean) : [];
}

function matchSegments(
  patternSegments: readonly string[],
  pathSegments: readonly string[],
  segmentPatterns: Map<string, RegExp>,
  patternIndex: number,
  pathIndex: number,
): boolean {
  if (patternIndex >= patternSegments.length) {
    return pathIndex >= pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];

  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) {
      return true;
    }

    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (
        matchSegments(
          patternSegments,
          pathSegments,
          segmentPatterns,
          patternIndex + 1,
          nextPathIndex,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  if (pathIndex >= pathSegments.length) {
    return false;
  }

  return (
    getSegmentPattern(patternSegment, segmentPatterns).test(pathSegments[pathIndex]) &&
    matchSegments(patternSegments, pathSegments, segmentPatterns, patternIndex + 1, pathIndex + 1)
  );
}

function getSegmentPattern(segment: string, cache: Map<string, RegExp>): RegExp {
  const cached = cache.get(segment);

  if (cached) {
    return cached;
  }

  const pattern = new RegExp(`^${compileSegmentPattern(segment)}$`);

  cache.set(segment, pattern);

  return pattern;
}

function compileSegmentPattern(segment: string): string {
  let pattern = "";

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];

    if (character === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (character === "?") {
      pattern += "[^/]";
      continue;
    }

    if (character === "{") {
      const closingBrace = findClosingBrace(segment, index);

      if (closingBrace > index + 1) {
        const alternatives = segment
          .slice(index + 1, closingBrace)
          .split(",")
          .filter(Boolean)
          .map((value) => compileSegmentPattern(value));

        if (alternatives.length) {
          pattern += `(?:${alternatives.join("|")})`;
          index = closingBrace;
          continue;
        }
      }
    }

    pattern += escapeRegexCharacter(character);
  }

  return pattern;
}

function findClosingBrace(segment: string, startIndex: number): number {
  for (let index = startIndex + 1; index < segment.length; index += 1) {
    if (segment[index] === "}") {
      return index;
    }
  }

  return -1;
}

function escapeRegexCharacter(character: string): string {
  return /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/");
}
