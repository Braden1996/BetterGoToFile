import * as vscode from "vscode";
import type { FileEntry } from "./file-entry";
import { shouldIncludeGitignoredFile, type GitignoredVisibility } from "./gitignored-visibility";
import { scoreSearchCandidates, type GitTrackingState, type SearchContext } from "./search-ranking";

const MAX_VISIBLE_RESULTS = 200;
const DEFAULT_PATH_TAIL_SEGMENTS = 3;
const DEFAULT_COLLAPSED_TAIL_SEGMENTS = 2;
const QUERY_CONTEXT_RADIUS = 1;
const MAX_ROW_WIDTH_UNITS = 72;
const LABEL_PADDING_WIDTH_UNITS = 8;
const MIN_DESCRIPTION_WIDTH_UNITS = 16;

export interface FilePickItem extends vscode.QuickPickItem {
  readonly entry?: FileEntry;
}

export type ResolveFileIcon = (entry: FileEntry) => vscode.IconPath | undefined;
export type FileSearchRankingContext = SearchContext<FileEntry>;

export function toQuickPickItems(
  entries: readonly FileEntry[],
  query: string,
  rankingContext: FileSearchRankingContext = {},
  resolveFileIcon?: ResolveFileIcon,
  gitignoredIconPath?: vscode.IconPath,
  gitignoredVisibility: GitignoredVisibility = "auto",
  showScores = false,
): FilePickItem[] {
  const visibleEntries = entries.filter((entry) =>
    shouldIncludeEntry(entry, query, rankingContext, gitignoredVisibility),
  );
  const rankedEntries = scoreSearchCandidates(
    visibleEntries,
    query,
    rankingContext,
    MAX_VISIBLE_RESULTS,
  );

  if (!rankedEntries.length) {
    return [
      {
        label: "No matching files",
        alwaysShow: true,
      },
    ];
  }

  return rankedEntries.map(({ candidate: entry, total }) => {
    const gitTrackingState = rankingContext.getGitTrackingState?.(entry) ?? "unknown";
    const iconPath = gitTrackingState === "ignored" ? gitignoredIconPath : resolveFileIcon?.(entry);

    return {
      label: entry.basename,
      description: buildDescription(entry, query, gitTrackingState),
      detail: showScores ? formatScoreDetail(total) : undefined,
      iconPath: iconPath ?? vscode.ThemeIcon.File,
      resourceUri: iconPath ? undefined : entry.uri,
      entry,
    };
  });
}

function buildDescription(
  entry: FileEntry,
  query: string,
  gitTrackingState: GitTrackingState,
): string | undefined {
  const segments = [entry.workspaceFolderName, ...splitSegments(entry.directory)].filter(isDefined);
  const gitTag = gitTrackingState === "ignored" ? "[gitignored]" : undefined;

  if (!segments.length) {
    return gitTag;
  }

  const queryTokens = tokenizeQuery(query).filter((token) => token.length > 1);
  const availableWidth = getAvailableDescriptionWidth(entry.basename);
  const candidates = buildDescriptionCandidates(
    segments,
    queryTokens,
    Boolean(entry.workspaceFolderName),
  );

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
  keepFirstSegment: boolean,
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
          keepFirstSegment,
          QUERY_CONTEXT_RADIUS,
          DEFAULT_PATH_TAIL_SEGMENTS,
        ),
      );
      candidates.add(
        collapseAroundMatches(
          segments,
          matchedIndices,
          keepFirstSegment,
          0,
          DEFAULT_PATH_TAIL_SEGMENTS,
        ),
      );
      candidates.add(
        collapseAroundMatches(
          segments,
          matchedIndices,
          keepFirstSegment,
          0,
          DEFAULT_COLLAPSED_TAIL_SEGMENTS,
        ),
      );
    }
  }

  candidates.add(collapseToTail(segments, keepFirstSegment, DEFAULT_PATH_TAIL_SEGMENTS));
  candidates.add(collapseToTail(segments, keepFirstSegment, DEFAULT_COLLAPSED_TAIL_SEGMENTS));
  candidates.add(collapseToTail(segments, keepFirstSegment, 1));

  return [...candidates];
}

function collapseToTail(
  segments: readonly string[],
  keepFirstSegment: boolean,
  tailSegmentCount: number,
): string {
  if (segments.length <= tailSegmentCount + Number(keepFirstSegment)) {
    return segments.join("/");
  }

  const tail = segments.slice(-tailSegmentCount).join("/");

  if (keepFirstSegment) {
    return `${segments[0]}/…/${tail}`;
  }

  return `…/${tail}`;
}

function collapseAroundMatches(
  segments: readonly string[],
  matchedIndices: readonly number[],
  keepFirstSegment: boolean,
  contextRadius: number,
  tailSegmentCount: number,
): string {
  const keptIndices = new Set<number>();

  if (keepFirstSegment) {
    keptIndices.add(0);
  }

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

function getAvailableDescriptionWidth(basename: string): number {
  return Math.max(
    MIN_DESCRIPTION_WIDTH_UNITS,
    MAX_ROW_WIDTH_UNITS - estimateTextWidth(basename) - LABEL_PADDING_WIDTH_UNITS,
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

function shouldIncludeEntry(
  entry: FileEntry,
  query: string,
  rankingContext: FileSearchRankingContext,
  gitignoredVisibility: GitignoredVisibility,
): boolean {
  const gitTrackingState = rankingContext.getGitTrackingState?.(entry) ?? "unknown";

  if (gitTrackingState !== "ignored") {
    return true;
  }

  return shouldIncludeGitignoredFile(query, gitignoredVisibility);
}

function formatScoreDetail(score: number): string {
  return `score ${Math.round(score).toLocaleString("en-US")}`;
}
