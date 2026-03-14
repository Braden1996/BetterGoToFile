interface FilePickerPendingState {
  readonly currentSource: "empty" | "cache" | "live";
  readonly hasEntries: boolean;
  readonly isIndexing: boolean;
  readonly isRestoringSnapshot: boolean;
  readonly pickerReadiness: {
    readonly isReady: boolean;
    readonly isWorkspaceIndexReady: boolean;
    readonly isFrecencyReady: boolean;
    readonly isGitTrackingReady: boolean;
    readonly isContributorRelationshipsReady: boolean;
  };
  readonly query: string;
}

type FilePickerLockState = Omit<FilePickerPendingState, "query" | "pickerReadiness">;

export function formatFilePickerTitle(isSearching: boolean): string {
  return isSearching ? "Better Go To File - Searching..." : "Better Go To File";
}

export function getPendingFilePickerItem(
  state: FilePickerPendingState,
): { label: string; description: string; alwaysShow: true } | undefined {
  if (!state.pickerReadiness.isReady) {
    const waitDescription = formatPendingReadinessDescription(state.pickerReadiness);

    return {
      label: state.query.trim() ? "Searching workspace files..." : "Loading workspace files...",
      description: state.hasEntries
        ? `${waitDescription} before showing cached results.`
        : `${waitDescription}.`,
      alwaysShow: true,
    };
  }

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

function formatPendingReadinessDescription(
  state: FilePickerPendingState["pickerReadiness"],
): string {
  const pendingRequirements = collectPendingRequirementLabels(state);

  if (!pendingRequirements.length) {
    return "Preparing search ranking";
  }

  return `Waiting for ${formatPendingRequirementLabels(pendingRequirements)}`;
}

function collectPendingRequirementLabels(
  state: FilePickerPendingState["pickerReadiness"],
): string[] {
  const pendingRequirements: string[] = [];

  if (!state.isWorkspaceIndexReady) {
    pendingRequirements.push("workspace index");
  }

  if (!state.isFrecencyReady) {
    pendingRequirements.push("recent visits");
  }

  if (!state.isGitTrackingReady) {
    pendingRequirements.push("Git status");
  }

  if (!state.isContributorRelationshipsReady) {
    pendingRequirements.push("contributor history");
  }

  return pendingRequirements;
}

function formatPendingRequirementLabels(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}
