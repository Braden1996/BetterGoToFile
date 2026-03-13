interface FilePickerPendingState {
  readonly currentSource: "empty" | "cache" | "live";
  readonly hasEntries: boolean;
  readonly isIndexing: boolean;
  readonly isRestoringSnapshot: boolean;
  readonly query: string;
}

type FilePickerLockState = Omit<FilePickerPendingState, "query">;

export function formatFilePickerTitle(isSearching: boolean): string {
  return isSearching ? "Better Go To File - Searching..." : "Better Go To File";
}

export function getPendingFilePickerItem(
  state: FilePickerPendingState,
): { label: string; description: string; alwaysShow: true } | undefined {
  if (state.hasEntries) {
    return undefined;
  }

  if (!state.isIndexing && !state.isRestoringSnapshot) {
    return undefined;
  }

  return {
    label: state.query.trim() ? "Searching workspace files..." : "Loading workspace files...",
    description:
      state.currentSource === "cache"
        ? "Showing cached results as the live index refreshes."
        : "Results will appear as the workspace index becomes ready.",
    alwaysShow: true,
  };
}

export function shouldLockFilePickerEntries(state: FilePickerLockState): boolean {
  if (!state.hasEntries) {
    return false;
  }

  if (state.currentSource === "live") {
    return true;
  }

  return !state.isIndexing && !state.isRestoringSnapshot;
}
