import { describe, expect, test } from "bun:test";
import {
  buildContributorRelationshipGraph,
  createContributorIdentity,
  rankContributorRelationships,
  type ContributorTouch,
} from "../src/workspace/contributor-relationship-model";

const NOW_MS = Date.UTC(2026, 2, 8);

function createTouch(
  name: string,
  email: string,
  ageDays: number,
  touchedPaths: readonly string[],
): ContributorTouch {
  return {
    contributor: createContributorIdentity(name, email),
    committedAtMs: NOW_MS - ageDays * 24 * 60 * 60 * 1000,
    touchedPaths,
  };
}

describe("buildContributorRelationshipGraph", () => {
  test("merges self aliases into one contributor profile", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden Marshall", "braden1996@hotmail.co.uk", 3, ["src/app.ts"]),
        createTouch("Braden Marshall", "braden@attio.com", 2, ["src/search.ts"]),
        createTouch("Alex", "alex@attio.com", 2, ["src/search.ts"]),
      ],
      {
        currentContributor: {
          name: "Braden Marshall",
          email: "braden1996@hotmail.co.uk",
        },
        nowMs: NOW_MS,
      },
    );

    expect(graph.currentContributorKey).toBe("email:braden1996@hotmail.co.uk");
    expect(graph.contributors.map((summary) => summary.contributor.key)).toEqual([
      "email:braden1996@hotmail.co.uk",
      "email:alex@attio.com",
    ]);
    expect(
      graph.contributors.find((summary) => summary.contributor.key === graph.currentContributorKey)
        ?.touchedCommitCount,
    ).toBe(2);
    expect(graph.contributorFiles.get("email:braden1996@hotmail.co.uk")).toEqual(
      new Set(["src/app.ts", "src/search.ts"]),
    );
  });

  test("filters touched paths to tracked files before counting commits", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 1, ["src/app.ts", "deleted.ts"]),
        createTouch("Alex", "alex@example.com", 1, ["src/app.ts", "README.md"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
        trackedPaths: new Set(["src/app.ts", "README.md"]),
      },
    );

    expect(
      graph.contributors.map((summary) => [
        summary.contributor.key,
        summary.touchedFileCount,
        summary.touchedCommitCount,
      ]),
    ).toEqual([
      ["email:alex@example.com", 2, 1],
      ["email:braden@example.com", 1, 1],
    ]);
  });
});

describe("rankContributorRelationships", () => {
  test("prefers repeated focused overlap over a one-off broad sweep", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["src/a.ts", "src/b.ts"]),
        createTouch("Braden", "braden@example.com", 4, ["src/a.ts"]),
        createTouch("Focused", "focused@example.com", 1, ["src/a.ts"]),
        createTouch("Focused", "focused@example.com", 3, ["src/a.ts", "src/b.ts"]),
        createTouch("Sweep", "sweep@example.com", 1, [
          "src/a.ts",
          "src/b.ts",
          ...Array.from({ length: 40 }, (_, index) => `src/generated-${index}.ts`),
        ]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 2,
      sampleSize: 2,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:focused@example.com",
      "email:sweep@example.com",
    ]);
    expect(relationships[0]?.relationshipScore).toBeGreaterThan(
      relationships[1]?.relationshipScore ?? 0,
    );
    expect(relationships[0]?.precision).toBeGreaterThan(relationships[1]?.precision ?? 0);
  });

  test("matches nearby files via directory ownership ripple", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["src/search/rank.ts"]),
        createTouch("Braden", "braden@example.com", 4, ["src/search/index.ts"]),
        createTouch("Search", "search@example.com", 3, ["src/search/cache.ts"]),
        createTouch("UI", "ui@example.com", 3, ["src/ui/button.ts"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 2,
      sampleSize: 3,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:search@example.com",
      "email:ui@example.com",
    ]);
    expect(relationships[0]?.sharedFileCount).toBe(0);
    expect(relationships[0]?.sharedNodeCount).toBeGreaterThan(
      relationships[1]?.sharedNodeCount ?? 0,
    );
    expect(relationships[0]?.sampleSharedPaths.includes("src/search/")).toBe(true);
  });

  test("prefers recent overlap over cooling activity", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["src/core.ts"]),
        createTouch("Braden", "braden@example.com", 6, ["src/core.ts"]),
        createTouch("Recent", "recent@example.com", 3, ["src/core.ts"]),
        createTouch("Recent", "recent@example.com", 5, ["src/core.ts"]),
        createTouch("Cooling", "cooling@example.com", 80, ["src/core.ts"]),
        createTouch("Cooling", "cooling@example.com", 90, ["src/core.ts"]),
        createTouch("Cooling", "cooling@example.com", 100, ["src/core.ts"]),
        createTouch("Cooling", "cooling@example.com", 110, ["src/core.ts"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 2,
      sampleSize: 1,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:recent@example.com",
      "email:cooling@example.com",
    ]);
    expect(relationships[0]?.recentOverlapWeight).toBeGreaterThan(
      relationships[1]?.recentOverlapWeight ?? 0,
    );
    expect(relationships[0]?.activityFactor).toBeGreaterThan(relationships[1]?.activityFactor ?? 0);
  });

  test("uses freshness rather than recent commit volume for activity", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["src/core.ts"]),
        createTouch("Quiet", "quiet@example.com", 3, ["src/core.ts"]),
        createTouch("Busy", "busy@example.com", 3, ["src/core.ts"]),
        createTouch("Busy", "busy@example.com", 6, ["src/core.ts"]),
        createTouch("Busy", "busy@example.com", 9, ["src/core.ts"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 3,
      sampleSize: 1,
    });
    const quietRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:quiet@example.com",
    );
    const busyRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:busy@example.com",
    );

    expect(quietRelationship?.activityFactor).toBe(1);
    expect(busyRelationship?.activityFactor).toBe(1);
  });

  test("excludes contributors with no recent activity", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["src/core.ts"]),
        createTouch("Braden", "braden@example.com", 6, ["src/core.ts"]),
        createTouch("Recent", "recent@example.com", 3, ["src/core.ts"]),
        createTouch("Recent", "recent@example.com", 5, ["src/core.ts"]),
        createTouch("Former", "former@example.com", 160, ["src/core.ts"]),
        createTouch("Former", "former@example.com", 170, ["src/core.ts"]),
        createTouch("Former", "former@example.com", 180, ["src/core.ts"]),
        createTouch("Former", "former@example.com", 190, ["src/core.ts"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 3,
      sampleSize: 1,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:recent@example.com",
    ]);
  });

  test("penalizes cross-cutting setup work across package roots", () => {
    const trackedPaths = new Set([
      "package.json",
      "yarn.lock",
      "packages/app/package.json",
      "packages/app/src/feature.ts",
      "packages/app/src/model.ts",
      "packages/app/src/setup.ts",
      "packages/app/tsconfig.json",
      "packages/web/package.json",
      "packages/web/src/index.ts",
      "packages/web/tsconfig.json",
      "packages/design/package.json",
      "packages/design/src/theme.ts",
      "packages/design/tsconfig.json",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["packages/app/src/feature.ts"]),
        createTouch("Braden", "braden@example.com", 4, ["packages/app/src/model.ts"]),
        createTouch("Quiet", "quiet@example.com", 3, ["packages/app/src/feature.ts"]),
        createTouch("Quiet", "quiet@example.com", 7, ["packages/app/src/model.ts"]),
        createTouch("ESM", "esm@example.com", 1, [
          "package.json",
          "yarn.lock",
          "packages/app/package.json",
          "packages/web/package.json",
          "packages/design/package.json",
        ]),
        createTouch("ESM", "esm@example.com", 2, [
          "packages/app/src/feature.ts",
          "packages/app/tsconfig.json",
          "packages/web/tsconfig.json",
          "packages/design/tsconfig.json",
        ]),
        createTouch("ESM", "esm@example.com", 5, [
          "packages/app/src/setup.ts",
          "packages/web/src/index.ts",
          "packages/design/src/theme.ts",
        ]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
        trackedPaths,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 3,
      sampleSize: 2,
    });
    const quietRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:quiet@example.com",
    );
    const esmRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:esm@example.com",
    );

    expect(quietRelationship !== undefined).toBe(true);
    expect(esmRelationship !== undefined).toBe(true);
    expect(quietRelationship?.relationshipScore).toBeGreaterThan(
      esmRelationship?.relationshipScore ?? 0,
    );
    expect(quietRelationship?.activityFactor).toBe(1);
    expect(esmRelationship?.activityFactor).toBe(1);
  });

  test("downweights common files compared with specific overlap", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch("Braden", "braden@example.com", 2, ["package.json", "src/feature.ts"]),
        createTouch("Braden", "braden@example.com", 4, ["src/feature.ts"]),
        createTouch("Specific", "specific@example.com", 3, ["src/feature.ts"]),
        createTouch("Specific", "specific@example.com", 5, ["src/feature.ts"]),
        createTouch("Bot", "bot@example.com", 1, ["package.json"]),
        createTouch("Bot", "bot@example.com", 2, ["package.json"]),
        createTouch("Alex", "alex@example.com", 1, ["package.json"]),
        createTouch("Jamie", "jamie@example.com", 1, ["package.json"]),
        createTouch("Taylor", "taylor@example.com", 1, ["package.json"]),
      ],
      {
        currentContributor: {
          name: "Braden",
          email: "braden@example.com",
        },
        nowMs: NOW_MS,
      },
    );
    const relationships = rankContributorRelationships(graph, "email:braden@example.com", {
      limit: 2,
      sampleSize: 2,
    });

    expect(relationships[0]?.contributor.key).toBe("email:specific@example.com");
    expect(relationships[0]?.overlapWeight).toBeGreaterThan(relationships[1]?.overlapWeight ?? 0);
    expect(relationships[1]?.sharedFileCount).toBe(1);
  });
});
