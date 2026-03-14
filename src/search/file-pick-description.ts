import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type PickerDescriptionConfig } from "../config/schema";
import type { FileEntry, GitTrackingState } from "../workspace";

const ELLIPSIS = "…";
const MIN_TRUNCATED_LABEL_WIDTH_UNITS = 12;
const MIN_TRUNCATED_LABEL_RETAINED_RATIO = 0.45;

interface FilePickPresentation {
  readonly label: string;
  readonly description: string | undefined;
}

export function buildFilePickPresentation(
  entry: FileEntry,
  query: string,
  gitTrackingState: GitTrackingState,
  config: PickerDescriptionConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
): FilePickPresentation {
  const descriptionCandidates = buildDisplayDescriptionCandidates(
    entry,
    query,
    gitTrackingState,
    config,
  );
  const populatedDescriptionCandidates = descriptionCandidates.filter(isDefined);

  for (const description of populatedDescriptionCandidates) {
    if (fitsWithinRow(entry.basename, description, config)) {
      return {
        label: entry.basename,
        description,
      };
    }
  }

  for (const description of populatedDescriptionCandidates) {
    const availableLabelWidth = getAvailableLabelWidth(description, config);

    if (availableLabelWidth < MIN_TRUNCATED_LABEL_WIDTH_UNITS) {
      continue;
    }

    const truncatedLabel = truncateMiddle(entry.basename, availableLabelWidth);

    if (truncatedLabel === entry.basename) {
      return {
        label: entry.basename,
        description,
      };
    }

    if (!isMeaningfulLabelTruncation(entry.basename, truncatedLabel)) {
      continue;
    }

    return {
      label: truncatedLabel,
      description,
    };
  }

  if (fitsWithinRow(entry.basename, undefined, config)) {
    return {
      label: entry.basename,
      description: undefined,
    };
  }

  return {
    label: truncateMiddle(entry.basename, config.maxRowWidthUnits),
    description: populatedDescriptionCandidates.at(-1),
  };
}

export function buildFilePickDescription(
  entry: FileEntry,
  query: string,
  gitTrackingState: GitTrackingState,
  config: PickerDescriptionConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
): string | undefined {
  const descriptionCandidates = buildDisplayDescriptionCandidates(
    entry,
    query,
    gitTrackingState,
    config,
  ).filter(isDefined);

  if (!descriptionCandidates.length) {
    return undefined;
  }

  const availableWidth = getAvailableDescriptionWidth(entry.basename, config);

  for (const candidate of descriptionCandidates) {
    if (estimateTextWidth(candidate) <= availableWidth) {
      return candidate;
    }
  }

  return descriptionCandidates[descriptionCandidates.length - 1];
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

function buildDisplayDescriptionCandidates(
  entry: FileEntry,
  query: string,
  gitTrackingState: GitTrackingState,
  config: PickerDescriptionConfig,
): (string | undefined)[] {
  const segments = [entry.workspaceFolderName, ...splitSegments(entry.directory)].filter(isDefined);
  const gitTag = gitTrackingState === "ignored" ? "[gitignored]" : undefined;

  if (!segments.length) {
    return gitTag ? [gitTag, undefined] : [undefined];
  }

  const queryTokens = tokenizeQuery(query).filter((token) => token.length > 1);
  const alwaysKeptIndices = collectAlwaysKeptIndices(
    segments,
    entry.workspaceFolderName,
    entry.packageRoot,
  );
  const candidates = buildDescriptionCandidates(segments, queryTokens, alwaysKeptIndices, config);
  const displayCandidates = candidates.map((candidate) => appendStatusTag(candidate, gitTag));

  if (gitTag) {
    displayCandidates.push(gitTag);
  }

  displayCandidates.push(undefined);

  return [...new Set(displayCandidates)];
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

function fitsWithinRow(
  label: string,
  description: string | undefined,
  config: PickerDescriptionConfig,
): boolean {
  return getRowWidth(label, description, config) <= config.maxRowWidthUnits;
}

function getRowWidth(
  label: string,
  description: string | undefined,
  config: PickerDescriptionConfig,
): number {
  return estimateTextWidth(label) + getDescriptionDisplayWidth(description, config);
}

function getAvailableLabelWidth(
  description: string | undefined,
  config: PickerDescriptionConfig,
): number {
  return Math.max(0, config.maxRowWidthUnits - getDescriptionDisplayWidth(description, config));
}

function getAvailableDescriptionWidth(basename: string, config: PickerDescriptionConfig): number {
  return Math.max(
    config.minDescriptionWidthUnits,
    config.maxRowWidthUnits - estimateTextWidth(basename) - config.labelPaddingWidthUnits,
  );
}

function getDescriptionDisplayWidth(
  description: string | undefined,
  config: PickerDescriptionConfig,
): number {
  if (!description) {
    return 0;
  }

  return config.labelPaddingWidthUnits + estimateTextWidth(description);
}

function truncateMiddle(value: string, maxWidth: number): string {
  if (estimateTextWidth(value) <= maxWidth) {
    return value;
  }

  if (maxWidth <= estimateTextWidth(ELLIPSIS)) {
    return ELLIPSIS;
  }

  const characters = [...value];

  if (characters.length <= 2) {
    return ELLIPSIS;
  }

  const extensionWidth = estimateTextWidth(getExtension(value));
  const targetSuffixWidth = Math.min(
    maxWidth - estimateTextWidth(ELLIPSIS),
    Math.max(maxWidth * 0.55, extensionWidth + 4),
  );
  let prefixEnd = 0;
  let prefixWidth = 0;
  let suffixStart = characters.length;
  let suffixWidth = 0;

  while (
    suffixStart > 1 &&
    suffixWidth + estimateCharacterWidth(characters[suffixStart - 1] ?? "") <= targetSuffixWidth
  ) {
    suffixStart -= 1;
    suffixWidth += estimateCharacterWidth(characters[suffixStart] ?? "");
  }

  while (
    prefixEnd < suffixStart - 1 &&
    prefixWidth + suffixWidth + estimateTextWidth(ELLIPSIS) <= maxWidth
  ) {
    const nextWidth = estimateCharacterWidth(characters[prefixEnd] ?? "");

    if (prefixWidth + suffixWidth + nextWidth + estimateTextWidth(ELLIPSIS) > maxWidth) {
      break;
    }

    prefixWidth += nextWidth;
    prefixEnd += 1;
  }

  while (
    suffixStart > prefixEnd + 1 &&
    prefixWidth + suffixWidth + estimateTextWidth(ELLIPSIS) <= maxWidth
  ) {
    const nextWidth = estimateCharacterWidth(characters[suffixStart - 1] ?? "");

    if (prefixWidth + suffixWidth + nextWidth + estimateTextWidth(ELLIPSIS) > maxWidth) {
      break;
    }

    suffixStart -= 1;
    suffixWidth += nextWidth;
  }

  if (prefixEnd === 0) {
    prefixEnd = 1;
  }

  if (suffixStart <= prefixEnd) {
    suffixStart = Math.min(prefixEnd + 1, characters.length - 1);
  }

  const prefix = characters.slice(0, prefixEnd).join("");
  const suffix = characters.slice(suffixStart).join("");

  return `${prefix}${ELLIPSIS}${suffix}`;
}

function getExtension(value: string): string {
  const extensionStart = value.lastIndexOf(".");

  return extensionStart > 0 ? value.slice(extensionStart) : "";
}

function isMeaningfulLabelTruncation(original: string, truncated: string): boolean {
  const retainedWidth = Math.max(0, estimateTextWidth(truncated) - estimateTextWidth(ELLIPSIS));
  const originalWidth = estimateTextWidth(original);

  if (originalWidth === 0) {
    return true;
  }

  return retainedWidth / originalWidth >= MIN_TRUNCATED_LABEL_RETAINED_RATIO;
}

function estimateTextWidth(value: string): number {
  let total = 0;

  for (const char of value) {
    total += estimateCharacterWidth(char);
  }

  return total;
}

function estimateCharacterWidth(char: string): number {
  if (char === ELLIPSIS) {
    return 1.1;
  }

  if (char === " ") {
    return 0.4;
  }

  if (char === "/" || char === "\\" || char === "." || char === "-" || char === "_") {
    return 0.55;
  }

  if (/[()[\]{}'`",;:!]/.test(char)) {
    return 0.6;
  }

  if (/[ijlI1|]/.test(char)) {
    return 0.55;
  }

  if (/[frtJ]/.test(char)) {
    return 0.75;
  }

  if (/[mwMW@#%&]/.test(char)) {
    return 1.3;
  }

  if (/[A-Z]/.test(char)) {
    return 1;
  }

  if (/[0-9]/.test(char)) {
    return 0.95;
  }

  if (/[a-z]/.test(char)) {
    return 0.9;
  }

  return 1.05;
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
