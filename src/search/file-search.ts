import * as vscode from "vscode";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type BetterGoToFileConfig } from "../config/schema";
import type { FileEntry, GitTrackingState } from "../workspace";
import { buildFilePickDescription } from "./file-pick-description";
import { shouldIncludeGitignoredFile } from "./gitignored-visibility";
import { formatDebugScoreDetail } from "./search-score-detail";
import { scoreSearchCandidates, type SearchContext } from "./search-ranking";

export interface FilePickItem extends vscode.QuickPickItem {
  readonly entry?: FileEntry;
}

type ResolveFileIcon = (entry: FileEntry) => vscode.IconPath | undefined;
export type FileSearchRankingContext = SearchContext<FileEntry>;

interface FilePickOptions {
  readonly debugScoring?: boolean;
}

export function toQuickPickItems(
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
): FilePickItem[] {
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
    if (shouldIncludeEntry(entry, query, getGitTrackingState, config)) {
      visibleEntries.push(entry);
    }
  }

  const rankedEntries = scoreSearchCandidates(
    visibleEntries,
    query,
    {
      ...rankingContext,
      getGitTrackingState,
    },
    config.picker.maxVisibleResults,
    config.ranking,
  );

  if (!rankedEntries.length) {
    return [
      {
        label: "No matching files",
        alwaysShow: true,
      },
    ];
  }

  return rankedEntries.map(({ candidate: entry, total, breakdown }) => {
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
  });
}

function shouldIncludeEntry(
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
