import { describe, expect, test } from "bun:test";
import { renderContributorRelationshipsViewHtml } from "../src/app/views/contributor-relationships-view-html";

type WorkspaceContributorRelationshipSnapshot = Parameters<
  typeof renderContributorRelationshipsViewHtml
>[0][number];

describe("contributor relationships view", () => {
  test("renders relationship score breakdown columns for ready snapshots", () => {
    const html = renderContributorRelationshipsViewHtml(
      [createReadySnapshot()],
      Date.UTC(2026, 2, 13),
    );

    expect(html).toContain("Relationship score blends fast and slow shared-area overlap");
    expect(html).toContain("Fast overlap");
    expect(html).toContain("Focus factor");
    expect(html).toContain("Selected contributor");
    expect(html).toContain("View as");
    expect(html).toContain("data-contributor-select");
    expect(html).toContain("Alex");
    expect(html).toContain("72.0%");
    expect(html).toContain("packages/app/src/search, packages/app/src/shared");
    expect(html).toContain("Rows are sorted by relationship score");
    expect(html).toContain("Use detected contributor");
  });

  test("explains when the configured contributor is missing but still shows contributor rows", () => {
    const html = renderContributorRelationshipsViewHtml(
      [createNoCurrentContributorSnapshot()],
      Date.UTC(2026, 2, 13),
    );

    expect(html).toContain("current contributor missing");
    expect(html).toContain("Configured contributor");
    expect(html).toContain("was not found in repository history");
    expect(html).toContain("Select a contributor");
    expect(html).toContain("Taylor");
    expect(html).toContain("Morgan");
    expect(html).toContain("repository breadth");
  });
});

function createReadySnapshot(): WorkspaceContributorRelationshipSnapshot {
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

function createNoCurrentContributorSnapshot(): WorkspaceContributorRelationshipSnapshot {
  return {
    workspaceFolderName: "workspace",
    workspaceFolderPath: "/workspace",
    repoRootPath: "/workspace",
    status: "no-current-contributor",
    configuredContributor: {
      name: "Unknown",
      email: "unknown@example.com",
    },
    currentContributorFileCount: 0,
    currentContributorCommitCount: 0,
    currentContributorAreaFastWeight: 0,
    currentContributorAreaSlowWeight: 0,
    currentContributorFileFastWeight: 0,
    currentContributorFileSlowWeight: 0,
    trackedFileCount: 120,
    contributorCount: 2,
    contributors: [
      {
        contributor: {
          key: "email:taylor@example.com",
          name: "Taylor",
          email: "taylor@example.com",
        },
        touchedFileCount: 12,
        touchedCommitCount: 22,
        recentCommitCount: 6,
        lastCommitAgeDays: 1,
        areaFastWeight: 1.3,
        areaSlowWeight: 1.4,
        fileFastWeight: 0.9,
        fileSlowWeight: 1,
        broadness: 0.18,
      },
      {
        contributor: {
          key: "email:morgan@example.com",
          name: "Morgan",
          email: "morgan@example.com",
        },
        touchedFileCount: 9,
        touchedCommitCount: 15,
        recentCommitCount: 3,
        lastCommitAgeDays: 7,
        areaFastWeight: 0.8,
        areaSlowWeight: 0.9,
        fileFastWeight: 0.6,
        fileSlowWeight: 0.7,
        broadness: 0.22,
      },
    ],
    relationships: [],
    topContributors: [],
  };
}
