import * as vscode from "vscode";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type BetterGoToFileConfig } from "../config/schema";
import type { FileEntry, GitTrackingState } from "../workspace";
import { buildFilePickDescription } from "./file-pick-description";
import { shouldIncludeGitignoredFile } from "./gitignored-visibility";
import { formatDebugScoreDetail } from "./search-score-detail";
import {
  collectRankedSearchCandidates,
  scoreSearchCandidates,
  type SearchContext,
} from "./search-ranking";

export interface FilePickItem extends vscode.QuickPickItem {
  readonly entry?: FileEntry;
}

type ResolveFileIcon = (entry: FileEntry) => vscode.IconPath | undefined;
export type FileSearchRankingContext = SearchContext<FileEntry>;

interface FilePickOptions {
  readonly debugScoring?: boolean;
}

interface FileSearchResult {
  readonly items: readonly FilePickItem[];
  readonly matchedEntries: readonly FileEntry[];
}

export function searchFileItems(
  entries: readonly FileEntry[],
  query: string,
  rankingContext: FileSearchRankingContext = {},
  resolveFileIcon?: ResolveFileIcon,
  resolveGitignoredIcon?: ResolveFileIcon,
  config: Pick<
    BetterGoToFileConfig,
    "gitignored" | "picker" | "ranking"
  > = DEFAULT_BETTER_GO_TO_FILE_CONFIG,
  options: FilePickOptions = {},
): FileSearchResult {
  const gitTrackingStateByPath = new Map<string, GitTrackingState>();
  const getGitTrackingState = (entry: FileEntry): GitTrackingState => {
    const cachedState = gitTrackingStateByPath.get(entry.relativePath);

    if (cachedState !== undefined) {
      return cachedState;
    }

    const gitTrackingState = rankingContext.getGitTrackingState?.(entry) ?? "unknown";

    gitTrackingStateByPath.set(entry.relativePath, gitTrackingState);
    return gitTrackingState;
  };
  const visibleEntries: FileEntry[] = [];

  for (const entry of entries) {
    if (shouldIncludeFileEntry(entry, query, getGitTrackingState, config)) {
      visibleEntries.push(entry);
    }
  }

  const searchContext = {
    ...rankingContext,
    getGitTrackingState,
  };
  const rankedSearch = collectRankedSearchCandidates(
    visibleEntries,
    query,
    searchContext,
    config.picker.maxVisibleResults,
    config.ranking,
  );
  const showDetailedScores = options.debugScoring || config.picker.showScores;

  if (!showDetailedScores) {
    return {
      matchedEntries: rankedSearch.matchedCandidates,
      items: createQuickPickItems(
        rankedSearch.rankedCandidates,
        query,
        getGitTrackingState,
        resolveFileIcon,
        resolveGitignoredIcon,
        config,
      ),
    };
  }

  const rankedEntries = scoreSearchCandidates(
    visibleEntries,
    query,
    searchContext,
    config.picker.maxVisibleResults,
    config.ranking,
  );

  if (!rankedEntries.length) {
    return {
      matchedEntries: rankedSearch.matchedCandidates,
      items: [
        {
          label: "No matching files",
          alwaysShow: true,
        },
      ],
    };
  }

  return {
    matchedEntries: rankedSearch.matchedCandidates,
    items: rankedEntries.map(({ candidate: entry, total, breakdown }) => {
      const gitTrackingState = getGitTrackingState(entry);
      const iconPath =
        gitTrackingState === "ignored" ? resolveGitignoredIcon?.(entry) : resolveFileIcon?.(entry);

      return {
        label: entry.basename,
        description: buildFilePickDescription(
          entry,
          query,
          gitTrackingState,
          config.picker.description,
        ),
        detail: options.debugScoring
          ? formatDebugScoreDetail(total, breakdown)
          : config.picker.showScores
            ? formatScoreDetail(total)
            : undefined,
        alwaysShow: true,
        iconPath: iconPath ?? vscode.ThemeIcon.File,
        resourceUri: iconPath ? undefined : entry.uri,
        entry,
      };
    }),
  };
}

function createQuickPickItems(
  entries: readonly FileEntry[],
  query: string,
  getGitTrackingState: (entry: FileEntry) => GitTrackingState,
  resolveFileIcon?: ResolveFileIcon,
  resolveGitignoredIcon?: ResolveFileIcon,
  config: Pick<
    BetterGoToFileConfig,
    "gitignored" | "picker" | "ranking"
  > = DEFAULT_BETTER_GO_TO_FILE_CONFIG,
): FilePickItem[] {
  if (!entries.length) {
    return [
      {
        label: "No matching files",
        alwaysShow: true,
      },
    ];
  }

  return entries.map((entry) => {
    const gitTrackingState = getGitTrackingState(entry);
    const iconPath =
      gitTrackingState === "ignored" ? resolveGitignoredIcon?.(entry) : resolveFileIcon?.(entry);

    return {
      label: entry.basename,
      description: buildFilePickDescription(
        entry,
        query,
        gitTrackingState,
        config.picker.description,
      ),
      alwaysShow: true,
      iconPath: iconPath ?? vscode.ThemeIcon.File,
      resourceUri: iconPath ? undefined : entry.uri,
      entry,
    };
  });
}

export function shouldIncludeFileEntry(
  entry: FileEntry,
  query: string,
  getGitTrackingState: (entry: FileEntry) => GitTrackingState,
  config: Pick<BetterGoToFileConfig, "gitignored">,
): boolean {
  const gitTrackingState = getGitTrackingState(entry);

  if (gitTrackingState !== "ignored") {
    return true;
  }

  return shouldIncludeGitignoredFile(query, config.gitignored);
}

function formatScoreDetail(score: number): string {
  return `score ${Math.round(score).toLocaleString("en-US")}`;
}
