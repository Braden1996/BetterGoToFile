import * as vscode from "vscode";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type BetterGoToFileConfig } from "../config/schema";
import type { FileEntry, GitTrackingState } from "../workspace";
import { buildFilePickDescription } from "./file-pick-description";
import { shouldIncludeGitignoredFile } from "./gitignored-visibility";
import { scoreSearchCandidates, type SearchContext } from "./search-ranking";

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
  resolveGitignoredIcon?: ResolveFileIcon,
  config: Pick<
    BetterGoToFileConfig,
    "gitignored" | "picker" | "ranking"
  > = DEFAULT_BETTER_GO_TO_FILE_CONFIG,
): FilePickItem[] {
  const visibleEntries = entries.filter((entry) =>
    shouldIncludeEntry(entry, query, rankingContext, config),
  );
  const rankedEntries = scoreSearchCandidates(
    visibleEntries,
    query,
    rankingContext,
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

  return rankedEntries.map(({ candidate: entry, total }) => {
    const gitTrackingState = rankingContext.getGitTrackingState?.(entry) ?? "unknown";
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
      detail: config.picker.showScores ? formatScoreDetail(total) : undefined,
      iconPath: iconPath ?? vscode.ThemeIcon.File,
      resourceUri: iconPath ? undefined : entry.uri,
      entry,
    };
  });
}

function shouldIncludeEntry(
  entry: FileEntry,
  query: string,
  rankingContext: FileSearchRankingContext,
  config: Pick<BetterGoToFileConfig, "gitignored">,
): boolean {
  const gitTrackingState: GitTrackingState =
    rankingContext.getGitTrackingState?.(entry) ?? "unknown";

  if (gitTrackingState !== "ignored") {
    return true;
  }

  return shouldIncludeGitignoredFile(query, config.gitignored);
}

function formatScoreDetail(score: number): string {
  return `score ${Math.round(score).toLocaleString("en-US")}`;
}
