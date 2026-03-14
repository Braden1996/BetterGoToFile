import { describe, expect, test } from "bun:test";
import {
  buildContributorSearchProfile,
  buildContributorRelationshipGraph,
  collectMeaningfulAreaPrefixes,
  createContributorIdentity,
  rankContributorRelationships,
  scoreContributorFile,
  type ContributorTouch,
  type ContributorTouchedFile,
} from "../src/workspace/contributor-relationship-model";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 2, 8);

interface TouchOptions {
  readonly ageDays: number;
  readonly email: string;
  readonly files?: readonly ContributorTouchedFile[];
  readonly message?: string;
  readonly name: string;
  readonly touchedPaths?: readonly string[];
}

function createTouch({
  ageDays,
  email,
  files,
  message,
  name,
  touchedPaths,
}: TouchOptions): ContributorTouch {
  return {
    contributor: createContributorIdentity(name, email),
    committedAtMs: NOW_MS - ageDays * DAY_MS,
    files,
    message,
    touchedPaths: touchedPaths ?? files?.map((file) => file.path) ?? [],
  };
}

describe("collectMeaningfulAreaPrefixes", () => {
  test("keeps the full directory chain within a package scope", () => {
    expect(
      collectMeaningfulAreaPrefixes(
        "packages/app/src/domain/feature-a/team/current.ts",
        new Set(["packages/app"]),
      ),
    ).toEqual([
      "packages/app",
      "packages/app/src",
      "packages/app/src/domain",
      "packages/app/src/domain/feature-a",
      "packages/app/src/domain/feature-a/team",
    ]);
  });
});

describe("buildContributorRelationshipGraph", () => {
  test("merges self aliases into one contributor profile", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 3,
          email: "braden1996@hotmail.co.uk",
          name: "Braden Marshall",
          touchedPaths: ["src/app.ts"],
        }),
        createTouch({
          ageDays: 2,
          email: "braden@attio.com",
          name: "Braden Marshall",
          touchedPaths: ["src/search.ts"],
        }),
        createTouch({
          ageDays: 2,
          email: "alex@attio.com",
          name: "Alex",
          touchedPaths: ["src/search.ts"],
        }),
      ],
      {
        currentContributor: {
          name: "Braden Marshall",
          email: "braden1996@hotmail.co.uk",
        },
        nowMs: NOW_MS,
      },
    );

    const currentSummary = graph.contributors.find(
      (summary) => summary.contributor.key === graph.currentContributorKey,
    );

    expect(graph.currentContributorKey).toBe("email:braden1996@hotmail.co.uk");
    expect(graph.contributors.map((summary) => summary.contributor.key)).toEqual([
      "email:braden1996@hotmail.co.uk",
      "email:alex@attio.com",
    ]);
    expect(currentSummary?.touchedCommitCount).toBe(2);
    expect(graph.contributorFiles.get("email:braden1996@hotmail.co.uk")).toEqual(
      new Set(["src/app.ts", "src/search.ts"]),
    );
  });

  test("filters touched paths to tracked files before counting commits", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 1,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["src/app.ts", "deleted.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "alex@example.com",
          name: "Alex",
          touchedPaths: ["src/app.ts", "README.md"],
        }),
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
      new Map(
        graph.contributors.map((summary) => [
          summary.contributor.key,
          [summary.touchedFileCount, summary.touchedCommitCount],
        ]),
      ),
    ).toEqual(
      new Map([
        ["email:alex@example.com", [2, 1]],
        ["email:braden@example.com", [1, 1]],
      ]),
    );
  });

  test("merges contributor aliases that share a name and prefers non-noreply email", () => {
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "3684577+theadamborek@users.noreply.github.com",
          name: "Adam Borek",
          touchedPaths: ["src/one.ts"],
        }),
        createTouch({
          ageDays: 4,
          email: "adam@attio.com",
          name: "Adam Borek",
          touchedPaths: ["src/two.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "alex@example.com",
          name: "Alex",
          touchedPaths: ["src/two.ts"],
        }),
      ],
      {
        nowMs: NOW_MS,
      },
    );

    const adamSummary = graph.contributors.find(
      (summary) => summary.contributor.key === "email:adam@attio.com",
    );

    expect(graph.contributors.map((summary) => summary.contributor.key)).toEqual([
      "email:adam@attio.com",
      "email:alex@example.com",
    ]);
    expect(adamSummary?.touchedCommitCount).toBe(2);
    expect(adamSummary?.touchedFileCount).toBe(2);
    expect(adamSummary?.contributor.email).toBe("adam@attio.com");
  });
});

describe("rankContributorRelationships", () => {
  test("derives similarity from shared package-local area prefixes", () => {
    const trackedPaths = new Set([
      "packages/app/package.json",
      "packages/app/src/search/index.ts",
      "packages/app/src/search/rank.ts",
      "packages/app/src/search/cache.ts",
      "packages/ui/package.json",
      "packages/ui/src/button.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/search/rank.ts"],
        }),
        createTouch({
          ageDays: 4,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/search/index.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "search@example.com",
          name: "Search",
          touchedPaths: ["packages/app/src/search/cache.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "ui@example.com",
          name: "UI",
          touchedPaths: ["packages/ui/src/button.ts"],
        }),
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
      sampleSize: 3,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:search@example.com",
    ]);
    expect(relationships[0]?.sampleSharedAreas.includes("packages/app/src/search")).toBe(true);
  });

  test("preserves shared areas across renames through file lineage", () => {
    const trackedPaths = new Set([
      "packages/app/package.json",
      "packages/app/src/feature/current.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 1,
          email: "braden@example.com",
          files: [
            {
              path: "packages/app/src/feature/current.ts",
              previousPath: "packages/app/src/legacy/current.ts",
              status: "R100",
            },
          ],
          name: "Braden",
        }),
        createTouch({
          ageDays: 4,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/feature/current.ts"],
        }),
        createTouch({
          ageDays: 25,
          email: "teammate@example.com",
          files: [
            {
              path: "packages/app/src/legacy/current.ts",
            },
          ],
          name: "Teammate",
        }),
        createTouch({
          ageDays: 2,
          email: "other@example.com",
          name: "Other",
          touchedPaths: ["packages/app/src/legacy/other.ts"],
        }),
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
      sampleSize: 3,
    });

    expect(relationships[0]?.contributor.key).toBe("email:teammate@example.com");
    expect(relationships[0]?.sampleSharedAreas.includes("packages/app/src/feature")).toBe(true);
  });

  test("does not infer similarity only from generic ancestors above package roots", () => {
    const trackedPaths = new Set([
      "packages/runtimes/mobile-a/package.json",
      "packages/runtimes/mobile-a/src/current.ts",
      "packages/runtimes/mobile-a/src/peer.ts",
      "packages/runtimes/mobile-a/src/local.ts",
      "packages/runtimes/mobile-b/package.json",
      "packages/runtimes/mobile-b/src/index.ts",
      "packages/runtimes/mobile-c/package.json",
      "packages/runtimes/mobile-c/src/index.ts",
      "packages/runtimes/mobile-d/package.json",
      "packages/runtimes/mobile-d/src/index.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/runtimes/mobile-a/src/current.ts"],
        }),
        createTouch({
          ageDays: 5,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/runtimes/mobile-a/src/local.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "teammate@example.com",
          name: "Teammate",
          touchedPaths: ["packages/runtimes/mobile-a/src/peer.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "generic@example.com",
          name: "Generic",
          touchedPaths: ["packages/runtimes/mobile-b/src/index.ts"],
        }),
        createTouch({
          ageDays: 4,
          email: "generic@example.com",
          name: "Generic",
          touchedPaths: ["packages/runtimes/mobile-c/src/index.ts"],
        }),
        createTouch({
          ageDays: 7,
          email: "generic@example.com",
          name: "Generic",
          touchedPaths: ["packages/runtimes/mobile-d/src/index.ts"],
        }),
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

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:teammate@example.com",
    ]);
  });

  test("dilutes generic in-package ancestors behind focused feature overlap", () => {
    const trackedPaths = new Set([
      "packages/app/package.json",
      "packages/app/src/features/alpha/current.ts",
      "packages/app/src/features/alpha/helper.ts",
      "packages/app/src/features/alpha/peer.ts",
      "packages/app/src/features/beta/index.ts",
      "packages/app/src/features/gamma/index.ts",
      "packages/app/src/features/delta/index.ts",
      "packages/app/src/features/epsilon/index.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/features/alpha/current.ts"],
        }),
        createTouch({
          ageDays: 5,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/features/alpha/helper.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "focused@example.com",
          name: "Focused",
          touchedPaths: ["packages/app/src/features/alpha/peer.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "broad@example.com",
          name: "Broad",
          touchedPaths: [
            "packages/app/src/features/beta/index.ts",
            "packages/app/src/features/gamma/index.ts",
            "packages/app/src/features/delta/index.ts",
            "packages/app/src/features/epsilon/index.ts",
          ],
        }),
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
      sampleSize: 3,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:focused@example.com",
      "email:broad@example.com",
    ]);
    expect(relationships[0]?.sampleSharedAreas).toContain("packages/app/src/features/alpha");
  });

  test("treats quiet active teammates the same as busy active teammates", () => {
    const trackedPaths = new Set(["packages/app/package.json", "packages/app/src/core.ts"]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "quiet@example.com",
          name: "Quiet",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "busy@example.com",
          name: "Busy",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 6,
          email: "busy@example.com",
          name: "Busy",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 9,
          email: "busy@example.com",
          name: "Busy",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
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
      sampleSize: 1,
    });
    const quietRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:quiet@example.com",
    );
    const busyRelationship = relationships.find(
      (relationship) => relationship.contributor.key === "email:busy@example.com",
    );

    expect(quietRelationship !== undefined).toBe(true);
    expect(busyRelationship !== undefined).toBe(true);
    expect(quietRelationship?.activityFactor).toBe(1);
    expect(busyRelationship?.activityFactor).toBe(1);
    expect(
      Math.abs(
        (quietRelationship?.relationshipScore ?? 0) - (busyRelationship?.relationshipScore ?? 0),
      ),
    ).toBeLessThan(0.02);
  });

  test("excludes contributors with no recent activity", () => {
    const trackedPaths = new Set(["packages/app/package.json", "packages/app/src/core.ts"]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 6,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "recent@example.com",
          name: "Recent",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 5,
          email: "recent@example.com",
          name: "Recent",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 160,
          email: "former@example.com",
          name: "Former",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 170,
          email: "former@example.com",
          name: "Former",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
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
      sampleSize: 1,
    });

    expect(relationships.map((relationship) => relationship.contributor.key)).toEqual([
      "email:recent@example.com",
    ]);
  });

  test("penalizes broad mechanical setup work against focused package overlap", () => {
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
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/feature.ts"],
        }),
        createTouch({
          ageDays: 4,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/model.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "quiet@example.com",
          name: "Quiet",
          touchedPaths: ["packages/app/src/feature.ts"],
        }),
        createTouch({
          ageDays: 7,
          email: "quiet@example.com",
          name: "Quiet",
          touchedPaths: ["packages/app/src/model.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "esm@example.com",
          message: "chore: esm codemod",
          name: "ESM",
          touchedPaths: [
            "package.json",
            "yarn.lock",
            "packages/app/package.json",
            "packages/web/package.json",
            "packages/design/package.json",
          ],
        }),
        createTouch({
          ageDays: 2,
          email: "esm@example.com",
          message: "chore: format tsconfig for esm",
          name: "ESM",
          touchedPaths: [
            "packages/app/src/feature.ts",
            "packages/app/tsconfig.json",
            "packages/web/tsconfig.json",
            "packages/design/tsconfig.json",
          ],
        }),
        createTouch({
          ageDays: 5,
          email: "esm@example.com",
          message: "chore: esm entrypoint migration",
          name: "ESM",
          touchedPaths: [
            "packages/app/src/setup.ts",
            "packages/web/src/index.ts",
            "packages/design/src/theme.ts",
          ],
        }),
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
    expect(quietRelationship?.relationshipScore ?? 0).toBeGreaterThan(
      esmRelationship?.relationshipScore ?? 0,
    );
    expect(quietRelationship?.broadnessPenalty ?? 0).toBeGreaterThan(
      esmRelationship?.broadnessPenalty ?? 0,
    );
  });

  test("filters bot contributors from the relationship graph", () => {
    const trackedPaths = new Set(["packages/app/package.json", "packages/app/src/core.ts"]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 2,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
        createTouch({
          ageDays: 1,
          email: "49699333+dependabot[bot]@users.noreply.github.com",
          name: "dependabot[bot]",
          touchedPaths: ["packages/app/src/core.ts"],
        }),
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
    });

    expect(relationships).toEqual([]);
    expect(graph.contributors.map((summary) => summary.contributor.key)).toEqual([
      "email:braden@example.com",
    ]);
  });
});

describe("buildContributorSearchProfile", () => {
  test("scores files from self, teammate lineage, and shared area priors", () => {
    const trackedPaths = new Set([
      "packages/app/package.json",
      "packages/app/src/feature/current.ts",
      "packages/app/src/feature/sibling.ts",
      "packages/ui/package.json",
      "packages/ui/src/button.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 1,
          email: "braden@example.com",
          files: [
            {
              path: "packages/app/src/feature/current.ts",
              previousPath: "packages/app/src/legacy/current.ts",
              status: "R100",
            },
          ],
          name: "Braden",
        }),
        createTouch({
          ageDays: 5,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/feature/sibling.ts"],
        }),
        createTouch({
          ageDays: 9,
          email: "teammate@example.com",
          name: "Teammate",
          touchedPaths: ["packages/app/src/feature/sibling.ts"],
        }),
        createTouch({
          ageDays: 20,
          email: "teammate@example.com",
          files: [
            {
              path: "packages/app/src/legacy/current.ts",
            },
          ],
          name: "Teammate",
        }),
        createTouch({
          ageDays: 2,
          email: "ui@example.com",
          name: "UI",
          touchedPaths: ["packages/ui/src/button.ts"],
        }),
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
    const profile = buildContributorSearchProfile(graph, "email:braden@example.com");

    expect(profile).toBeDefined();

    const currentFileScore = scoreContributorFile(profile!, "packages/app/src/feature/current.ts");
    const siblingFileScore = scoreContributorFile(profile!, "packages/app/src/feature/sibling.ts");
    const unrelatedFileScore = scoreContributorFile(profile!, "packages/ui/src/button.ts");

    expect(currentFileScore.filePrior).toBeGreaterThan(0);
    expect(currentFileScore.teamPrior).toBeGreaterThan(0);
    expect(currentFileScore.ownerPrior).toBeGreaterThan(0);
    expect(siblingFileScore.areaPrior).toBeGreaterThan(0);
    expect(siblingFileScore.total).toBeGreaterThan(unrelatedFileScore.total);
  });

  test("propagates area priors through intermediate directories inside a package", () => {
    const trackedPaths = new Set([
      "packages/app/package.json",
      "packages/app/src/domain/feature-a/team/current.ts",
      "packages/app/src/domain/feature-a/team/helper.ts",
      "packages/app/src/domain/feature-b/candidate.ts",
      "packages/app/src/other/feature-c/candidate.ts",
    ]);
    const graph = buildContributorRelationshipGraph(
      [
        createTouch({
          ageDays: 1,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/domain/feature-a/team/current.ts"],
        }),
        createTouch({
          ageDays: 3,
          email: "braden@example.com",
          name: "Braden",
          touchedPaths: ["packages/app/src/domain/feature-a/team/helper.ts"],
        }),
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
    const profile = buildContributorSearchProfile(graph, "email:braden@example.com");

    expect(profile).toBeDefined();

    const sameDomainScore = scoreContributorFile(
      profile!,
      "packages/app/src/domain/feature-b/candidate.ts",
    );
    const otherDomainScore = scoreContributorFile(
      profile!,
      "packages/app/src/other/feature-c/candidate.ts",
    );

    expect(sameDomainScore.areaPrior).toBeGreaterThan(otherDomainScore.areaPrior);
    expect(sameDomainScore.total).toBeGreaterThan(otherDomainScore.total);
  });
});
