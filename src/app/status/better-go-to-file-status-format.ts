import {
  formatContributorIdentity,
  type ContributorRelationship,
} from "../../workspace/contributor-relationship-model";
import type { WorkspaceContributorRelationshipSnapshot } from "../../workspace/contributor-relationship-index";

export interface BetterGoToFileStatusPresentation {
  readonly index: {
    readonly isIndexing: boolean;
    readonly indexedFileCount: number;
    readonly maxFileCount: number;
    readonly workspaceFolderCount: number;
    readonly isAtFileLimit: boolean;
    readonly currentSource: "empty" | "cache" | "live";
    readonly isRestoringSnapshot: boolean;
    readonly isPersistingSnapshot: boolean;
    readonly lastRefreshStartedAt?: number;
    readonly lastRefreshCompletedAt?: number;
    readonly lastRefreshDurationMs?: number;
    readonly lastRefreshKind?: "full" | "partial";
    readonly restoredSnapshotAt?: number;
    readonly lastPersistedSnapshotAt?: number;
  };
  readonly openPathCount: number;
  readonly scoringPreset: string;
  readonly usingCustomScoring: boolean;
  readonly gitignoredVisibility: string;
  readonly contributorRelationships?: {
    readonly loadedWorkspaceFolderCount: number;
    readonly primarySnapshot?: WorkspaceContributorRelationshipSnapshot;
  };
}

export function formatBetterGoToFileStatusText(status: BetterGoToFileStatusPresentation): string {
  const count = formatCompactCount(status.index.indexedFileCount);

  if (status.index.isIndexing) {
    return `$(sync~spin) BGF ${count}`;
  }

  if (status.index.isAtFileLimit) {
    return `$(warning) BGF ${count}`;
  }

  if (status.index.currentSource === "cache") {
    return `$(database) BGF ${count}`;
  }

  return `$(search) BGF ${count}`;
}

export function formatBetterGoToFileStatusTooltip(
  status: BetterGoToFileStatusPresentation,
  now = Date.now(),
): string {
  const lines = [
    "**Better Go To File**",
    "",
    status.index.isIndexing ? "$(sync~spin) Indexing workspace files" : "$(check) Index ready",
    formatIndexSourceLine(status),
    `Files indexed: ${formatInteger(status.index.indexedFileCount)}`,
    `Workspace folders: ${formatInteger(status.index.workspaceFolderCount)}`,
    formatIndexLimitLine(status),
    formatSnapshotRestoreLine(status, now),
    formatSnapshotPersistLine(status, now),
    formatLastUpdateLine(status, now),
    formatLastUpdateKindLine(status),
    formatLastDurationLine(status),
    `Open tabs in ranking context: ${formatInteger(status.openPathCount)}`,
    `Scoring preset: \`${status.scoringPreset}${status.usingCustomScoring ? " + custom" : ""}\``,
    `Ignored files: \`${status.gitignoredVisibility}\``,
    "",
    ...formatContributorRelationshipLines(status),
    "",
    "[Open Picker](command:betterGoToFile.open) | [Contributor View](command:betterGoToFile.openContributorRelationshipsView) | [Open Debug](command:betterGoToFile.openDebug) | [Reindex Now](command:betterGoToFile.reindex)",
  ];

  return lines.filter(Boolean).join("  \n");
}

function formatIndexSourceLine(status: BetterGoToFileStatusPresentation): string {
  if (status.index.currentSource === "cache") {
    return status.index.isIndexing
      ? "Index source: restored snapshot cache (background refresh running)"
      : "Index source: restored snapshot cache";
  }

  if (status.index.currentSource === "live") {
    return "Index source: live workspace scan";
  }

  return "Index source: building initial index";
}

function formatContributorRelationshipLines(
  status: BetterGoToFileStatusPresentation,
): readonly string[] {
  const relationshipStatus = status.contributorRelationships;

  if (!relationshipStatus) {
    return [];
  }

  const lines = ["**Contributor Relationships**"];
  const snapshot = relationshipStatus.primarySnapshot;

  if (!snapshot) {
    lines.push("Loading contributor relationships...");

    return lines;
  }

  if (snapshot.status !== "ready" || !snapshot.relationships.length) {
    lines.push("No contributor relationships.");

    return lines;
  }

  snapshot.relationships.slice(0, 5).forEach((relationship, index) => {
    lines.push(formatContributorRelationshipLine(index, relationship));
  });

  return lines;
}

function formatIndexLimitLine(status: BetterGoToFileStatusPresentation): string {
  if (status.index.maxFileCount <= 0) {
    return "Index limit: unlimited";
  }

  if (status.index.isAtFileLimit) {
    return `Index limit: ${formatInteger(status.index.maxFileCount)} (at cap; workspace may contain more files)`;
  }

  return `Index limit: ${formatInteger(status.index.maxFileCount)}`;
}

function formatLastUpdateLine(status: BetterGoToFileStatusPresentation, now: number): string {
  if (status.index.lastRefreshCompletedAt) {
    return `Last index update: ${formatRelativeTime(status.index.lastRefreshCompletedAt, now)}`;
  }

  if (status.index.lastRefreshStartedAt) {
    return `Last index update: in progress (${formatRelativeTime(status.index.lastRefreshStartedAt, now)})`;
  }

  return "Last index update: not yet completed";
}

function formatSnapshotRestoreLine(status: BetterGoToFileStatusPresentation, now: number): string {
  if (status.index.isRestoringSnapshot) {
    return "Snapshot restore: loading cached workspace index";
  }

  if (status.index.restoredSnapshotAt) {
    return `Snapshot restore: restored snapshot from ${formatRelativeTime(status.index.restoredSnapshotAt, now)}`;
  }

  if (status.index.lastPersistedSnapshotAt) {
    return "Snapshot restore: not used in this session";
  }

  return "Snapshot restore: no cached snapshot yet";
}

function formatSnapshotPersistLine(status: BetterGoToFileStatusPresentation, now: number): string {
  if (status.index.isPersistingSnapshot) {
    return "Snapshot persistence: writing latest index";
  }

  if (status.index.lastPersistedSnapshotAt) {
    return `Last snapshot saved: ${formatRelativeTime(status.index.lastPersistedSnapshotAt, now)}`;
  }

  return "";
}

function formatLastUpdateKindLine(status: BetterGoToFileStatusPresentation): string {
  if (status.index.lastRefreshKind === "full") {
    return "Last update type: full workspace scan";
  }

  if (status.index.lastRefreshKind === "partial") {
    return "Last update type: partial subtree refresh";
  }

  return "";
}

function formatLastDurationLine(status: BetterGoToFileStatusPresentation): string {
  if (status.index.lastRefreshDurationMs === undefined) {
    return "";
  }

  return `Last update duration: ${formatDuration(status.index.lastRefreshDurationMs)}`;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${trimDecimal(value / 1_000_000)}m`;
  }

  if (value >= 1_000) {
    return `${trimDecimal(value / 1_000)}k`;
  }

  return value.toLocaleString("en-US");
}

function trimDecimal(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function formatContributorRelationshipLine(
  index: number,
  relationship: ContributorRelationship,
): string {
  return `${index + 1}. ${formatContributorIdentity(relationship.contributor)} ${formatScore(relationship.relationshipScore)}`;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const elapsedMs = Math.max(0, now - timestamp);

  if (elapsedMs < 5_000) {
    return "just now";
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);

  return `${elapsedDays}d ago`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${trimDecimal(durationMs / 1000)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);

  return `${minutes}m ${seconds}s`;
}

function formatScore(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
