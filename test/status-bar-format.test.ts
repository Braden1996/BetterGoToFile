import { describe, expect, test } from "bun:test";
import {
  formatBetterGoToFileStatusText,
  formatBetterGoToFileStatusTooltip,
  type BetterGoToFileStatusPresentation,
} from "../src/app/status/better-go-to-file-status-format";
import { type WorkspaceContributorRelationshipSnapshot } from "../src/workspace";

describe("better go to file status bar formatting", () => {
  test("keeps the status text compact while indexing", () => {
    expect(
      formatBetterGoToFileStatusText(createStatusPresentation({ index: { isIndexing: true } })),
    ).toBe("$(sync~spin) BGF 12.3k");
  });

  test("surfaces capped indexes with a warning icon", () => {
    expect(
      formatBetterGoToFileStatusText(
        createStatusPresentation({
          index: {
            isAtFileLimit: true,
            indexedFileCount: 50_000,
            maxFileCount: 50_000,
          },
        }),
      ),
    ).toBe("$(warning) BGF 50k");
  });

  test("shows a database icon when serving a restored snapshot", () => {
    expect(
      formatBetterGoToFileStatusText(
        createStatusPresentation({
          index: {
            currentSource: "cache",
          },
        }),
      ),
    ).toBe("$(database) BGF 12.3k");
  });

  test("puts richer runtime details in the hover tooltip", () => {
    const tooltip = formatBetterGoToFileStatusTooltip(
      createStatusPresentation({
        openPathCount: 9,
        scoringPreset: "balanced",
        usingCustomScoring: true,
        gitignoredVisibility: "auto",
        contributorRelationships: {
          loadedWorkspaceFolderCount: 1,
          primarySnapshot: createReadyRelationshipSnapshot(),
        },
        index: {
          currentSource: "cache",
          maxFileCount: 0,
          lastRefreshCompletedAt: 200_000,
          lastRefreshDurationMs: 1_250,
          lastRefreshKind: "partial",
          restoredSnapshotAt: 120_000,
          lastPersistedSnapshotAt: 210_000,
        },
      }),
      320_000,
    );

    expect(tooltip).toContain("**Better Go To File**");
    expect(tooltip).toContain("Index source: restored snapshot cache");
    expect(tooltip).toContain("Files indexed: 12,345");
    expect(tooltip).toContain("Index limit: unlimited");
    expect(tooltip).toContain("Snapshot restore: restored snapshot from 3m ago");
    expect(tooltip).toContain("Last snapshot saved: 1m ago");
    expect(tooltip).toContain("Last index update: 2m ago");
    expect(tooltip).toContain("Last update type: partial subtree refresh");
    expect(tooltip).toContain("Last update duration: 1.3s");
    expect(tooltip).toContain("Open tabs in ranking context: 9");
    expect(tooltip).toContain("Scoring preset: `balanced + custom`");
    expect(tooltip).toContain("**Contributor Relationships**");
    expect(tooltip).toContain("1. Alex <alex@example.com> 0.72");
    expect(tooltip).toContain("2. Jamie <jamie@example.com> 0.58");
    expect(tooltip).toContain(
      "[Contributor View](command:betterGoToFile.openContributorRelationshipsView)",
    );
    expect(tooltip).toContain("[Reindex Now](command:betterGoToFile.reindex)");
  });
});

function createStatusPresentation(
  overrides: {
    readonly index?: Partial<BetterGoToFileStatusPresentation["index"]>;
  } & Partial<Omit<BetterGoToFileStatusPresentation, "index">> = {},
): BetterGoToFileStatusPresentation {
  const { index: indexOverrides, ...statusOverrides } = overrides;
  const index = {
    isIndexing: false,
    indexedFileCount: 12_345,
    maxFileCount: 50_000,
    workspaceFolderCount: 1,
    isAtFileLimit: false,
    currentSource: "live" as const,
    isRestoringSnapshot: false,
    isPersistingSnapshot: false,
    lastRefreshStartedAt: 190_000,
    lastRefreshCompletedAt: 200_000,
    lastRefreshDurationMs: 850,
    lastRefreshKind: "full" as const,
    restoredSnapshotAt: undefined,
    lastPersistedSnapshotAt: undefined,
  };

  return {
    index: {
      ...index,
      ...indexOverrides,
    },
    openPathCount: 6,
    scoringPreset: "balanced",
    usingCustomScoring: false,
    gitignoredVisibility: "auto",
    ...statusOverrides,
  };
}

function createReadyRelationshipSnapshot(): WorkspaceContributorRelationshipSnapshot {
  return {
    workspaceFolderName: "workspace",
    workspaceFolderPath: "/workspace",
    repoRootPath: "/workspace",
    status: "ready",
    configuredContributor: {
      name: "Braden",
      email: "braden@example.com",
    },
    currentContributor: {
      key: "email:braden@example.com",
      name: "Braden",
      email: "braden@example.com",
    },
    currentContributorFileCount: 8,
    currentContributorCommitCount: 12,
    currentContributorAreaFastWeight: 1.2,
    currentContributorAreaSlowWeight: 1.4,
    currentContributorFileFastWeight: 0.9,
    currentContributorFileSlowWeight: 1.1,
    trackedFileCount: 120,
    contributorCount: 3,
    contributors: [
      {
        contributor: {
          key: "email:braden@example.com",
          name: "Braden",
          email: "braden@example.com",
        },
        touchedFileCount: 8,
        touchedCommitCount: 12,
        recentCommitCount: 5,
        lastCommitAgeDays: 1,
        areaFastWeight: 1.2,
        areaSlowWeight: 1.4,
        fileFastWeight: 0.9,
        fileSlowWeight: 1.1,
        broadness: 0.24,
      },
      {
        contributor: {
          key: "email:alex@example.com",
          name: "Alex",
          email: "alex@example.com",
        },
        touchedFileCount: 14,
        touchedCommitCount: 20,
        recentCommitCount: 4,
        lastCommitAgeDays: 2,
        areaFastWeight: 1.1,
        areaSlowWeight: 1.2,
        fileFastWeight: 0.8,
        fileSlowWeight: 1,
        broadness: 0.12,
      },
      {
        contributor: {
          key: "email:jamie@example.com",
          name: "Jamie",
          email: "jamie@example.com",
        },
        touchedFileCount: 11,
        touchedCommitCount: 16,
        recentCommitCount: 3,
        lastCommitAgeDays: 4,
        areaFastWeight: 0.9,
        areaSlowWeight: 1,
        fileFastWeight: 0.7,
        fileSlowWeight: 0.8,
        broadness: 0.2,
      },
    ],
    relationships: [
      {
        contributor: {
          key: "email:alex@example.com",
          name: "Alex",
          email: "alex@example.com",
        },
        relationshipScore: 0.72,
        activityFactor: 0.94,
        fastSimilarity: 0.81,
        slowSimilarity: 0.64,
        broadnessPenalty: 0.88,
        contributorBroadness: 0.12,
        sharedAreaCount: 5,
        contributorFileCount: 14,
        contributorCommitCount: 20,
        contributorRecentCommitCount: 4,
        contributorLastCommitAgeDays: 2,
        sampleSharedAreas: ["packages/app/src/search", "packages/app/src/shared"],
      },
      {
        contributor: {
          key: "email:jamie@example.com",
          name: "Jamie",
          email: "jamie@example.com",
        },
        relationshipScore: 0.58,
        activityFactor: 0.9,
        fastSimilarity: 0.7,
        slowSimilarity: 0.5,
        broadnessPenalty: 0.8,
        contributorBroadness: 0.2,
        sharedAreaCount: 3,
        contributorFileCount: 11,
        contributorCommitCount: 16,
        contributorRecentCommitCount: 3,
        contributorLastCommitAgeDays: 4,
        sampleSharedAreas: ["packages/app/src/ui"],
      },
    ],
    topContributors: [],
  };
}
