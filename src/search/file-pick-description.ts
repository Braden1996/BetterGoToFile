import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type PickerDescriptionConfig } from "../config/schema";
import type { FileEntry, GitTrackingState } from "../workspace";

export function buildFilePickDescription(
  entry: FileEntry,
  query: string,
  gitTrackingState: GitTrackingState,
  config: PickerDescriptionConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
): string | undefined {
  const segments = [entry.workspaceFolderName, ...splitSegments(entry.directory)].filter(isDefined);
  const gitTag = gitTrackingState === "ignored" ? "[gitignored]" : undefined;

  if (!segments.length) {
    return gitTag;
  }

  const queryTokens = tokenizeQuery(query).filter((token) => token.length > 1);
  const availableWidth = getAvailableDescriptionWidth(entry.basename, config);
  const alwaysKeptIndices = collectAlwaysKeptIndices(
    segments,
    entry.workspaceFolderName,
    entry.packageRoot,
  );
  const candidates = buildDescriptionCandidates(segments, queryTokens, alwaysKeptIndices, config);

  for (const candidate of candidates) {
    if (estimateTextWidth(candidate) <= availableWidth) {
      return appendStatusTag(candidate, gitTag);
    }
  }

  return appendStatusTag(candidates[candidates.length - 1], gitTag);
}

function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function splitSegments(value: string): string[] {
  return value ? value.split("/").filter(Boolean) : [];
}

function collectMatchingSegmentIndices(
  segments: readonly string[],
  queryTokens: readonly string[],
): number[] {
  const matchingIndices: number[] = [];

  for (const [index, segment] of segments.entries()) {
    const normalizedSegment = segment.toLowerCase();

    if (queryTokens.some((token) => normalizedSegment.includes(token))) {
      matchingIndices.push(index);
    }
  }

  return matchingIndices;
}

function buildDescriptionCandidates(
  segments: readonly string[],
  queryTokens: readonly string[],
  alwaysKeptIndices: readonly number[],
  config: PickerDescriptionConfig,
): string[] {
  const candidates = new Set<string>();

  candidates.add(segments.join("/"));

  if (queryTokens.length) {
    const matchedIndices = collectMatchingSegmentIndices(segments, queryTokens);

    if (matchedIndices.length) {
      candidates.add(
        collapseAroundMatches(
          segments,
          matchedIndices,
          alwaysKeptIndices,
          config.queryContextRadius,
          config.pathTailSegments,
        ),
      );
      candidates.add(
        collapseAroundMatches(
          segments,
          matchedIndices,
          alwaysKeptIndices,
          0,
          config.pathTailSegments,
        ),
      );
      candidates.add(
        collapseAroundMatches(
          segments,
          matchedIndices,
          alwaysKeptIndices,
          0,
          config.collapsedTailSegments,
        ),
      );
    }
  }

  candidates.add(collapseToTail(segments, alwaysKeptIndices, config.pathTailSegments));
  candidates.add(collapseToTail(segments, alwaysKeptIndices, config.collapsedTailSegments));
  candidates.add(collapseToTail(segments, alwaysKeptIndices, 1));

  return [...candidates];
}

function collapseToTail(
  segments: readonly string[],
  alwaysKeptIndices: readonly number[],
  tailSegmentCount: number,
): string {
  const keptIndices = new Set(alwaysKeptIndices);

  for (
    let index = Math.max(segments.length - tailSegmentCount, 0);
    index < segments.length;
    index += 1
  ) {
    keptIndices.add(index);
  }

  return collapseSegments(segments, keptIndices);
}

function collapseAroundMatches(
  segments: readonly string[],
  matchedIndices: readonly number[],
  alwaysKeptIndices: readonly number[],
  contextRadius: number,
  tailSegmentCount: number,
): string {
  const keptIndices = new Set(alwaysKeptIndices);

  for (const matchedIndex of matchedIndices) {
    for (
      let index = Math.max(0, matchedIndex - contextRadius);
      index <= Math.min(segments.length - 1, matchedIndex + contextRadius);
      index += 1
    ) {
      keptIndices.add(index);
    }
  }

  for (
    let index = Math.max(segments.length - tailSegmentCount, 0);
    index < segments.length;
    index += 1
  ) {
    keptIndices.add(index);
  }

  return collapseSegments(segments, keptIndices);
}

function collectAlwaysKeptIndices(
  segments: readonly string[],
  workspaceFolderName: string | undefined,
  packageRoot: string | undefined,
): number[] {
  const keptIndices = new Set<number>();

  if (workspaceFolderName) {
    keptIndices.add(0);
  }

  const packageRootSegments = packageRoot === undefined ? [] : splitSegments(packageRoot);

  if (packageRootSegments.length) {
    const packageDirectoryIndex =
      Number(Boolean(workspaceFolderName)) + packageRootSegments.length - 1;

    if (packageDirectoryIndex < segments.length) {
      keptIndices.add(packageDirectoryIndex);
    }
  }

  return [...keptIndices];
}

function collapseSegments(segments: readonly string[], keptIndices: ReadonlySet<number>): string {
  const collapsed: string[] = [];
  let lastKeptIndex = -1;

  for (let index = 0; index < segments.length; index += 1) {
    if (!keptIndices.has(index)) {
      continue;
    }

    if (index > 0 && lastKeptIndex === -1) {
      collapsed.push("…");
    } else if (lastKeptIndex >= 0 && index - lastKeptIndex > 1) {
      collapsed.push("…");
    }

    collapsed.push(segments[index]);
    lastKeptIndex = index;
  }

  return collapsed.join("/");
}

function getAvailableDescriptionWidth(basename: string, config: PickerDescriptionConfig): number {
  return Math.max(
    config.minDescriptionWidthUnits,
    config.maxRowWidthUnits - estimateTextWidth(basename) - config.labelPaddingWidthUnits,
  );
}

function estimateTextWidth(value: string): number {
  let total = 0;

  for (const char of value) {
    total += estimateCharacterWidth(char);
  }

  return total;
}

function estimateCharacterWidth(char: string): number {
  if (char === "…") {
    return 1.4;
  }

  if (char === "/" || char === "\\" || char === "." || char === "-" || char === "_") {
    return 0.65;
  }

  if (char === " ") {
    return 0.45;
  }

  if (/[A-Z]/.test(char)) {
    return 1.1;
  }

  if (/[a-z0-9]/.test(char)) {
    return 1;
  }

  return 1.2;
}

function appendStatusTag(value: string | undefined, tag: string | undefined): string | undefined {
  if (!tag) {
    return value;
  }

  if (!value) {
    return tag;
  }

  return `${value} ${tag}`;
}
