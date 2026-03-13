import { describe, expect, test } from "bun:test";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG } from "../src/config/schema";
import { isSpecificQuery, shouldIncludeGitignoredFile } from "../src/search/gitignored-visibility";
import {
  collectRankedSearchCandidates,
  rankSearchCandidates,
  scoreSearchCandidates,
  type SearchCandidate,
} from "../src/search/search-ranking";

function createCandidate(relativePath: string, packageRoot?: string): SearchCandidate {
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];
  const directory = segments.slice(0, -1).join("/");

  return {
    basename,
    relativePath,
    directory,
    packageRoot,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  };
}

describe("rankSearchCandidates", () => {
  test("prefers basename matches over path-only matches", () => {
    const candidates = [
      createCandidate("src/features/goToFile/historyIndex.ts"),
      createCandidate("src/indexing/history.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "history");

    expect(ranked[0]?.relativePath).toBe("src/indexing/history.ts");
  });

  test("uses frecency to break lexical ties", () => {
    const candidates = [
      createCandidate("src/app/config.ts"),
      createCandidate("src/core/config.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "config", {
      getFrecencyScore: (relativePath) => (relativePath === "src/app/config.ts" ? 8 : 0),
    });

    expect(ranked[0]?.relativePath).toBe("src/app/config.ts");
  });

  test("uses git priors to rerank ambiguous basename matches", () => {
    const candidates = [
      createCandidate("packages/ui/src/button.ts"),
      createCandidate("packages/app/src/button.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "button", {
      getGitPrior: (candidate) => (candidate.relativePath === "packages/app/src/button.ts" ? 8 : 0),
    });

    expect(ranked[0]?.relativePath).toBe("packages/app/src/button.ts");
  });

  test("prefers package and basename intent over a single overloaded basename", () => {
    const candidates = [
      createCandidate(
        "packages/libraries/native/mobile-picasso/src/components/Button/button-container.component.tsx",
        "packages/libraries/native/mobile-picasso",
      ),
      createCandidate(
        "packages/design-system/src/components/mobile-button.component.tsx",
        "packages/design-system",
      ),
    ];

    const ranked = rankSearchCandidates(candidates, "mobile button");

    expect(ranked[0]?.relativePath).toBe(
      "packages/libraries/native/mobile-picasso/src/components/Button/button-container.component.tsx",
    );
  });

  test("does not let git priors bulldoze explicit path intent", () => {
    const candidates = [
      createCandidate("packages/web/src/button-view.ts"),
      createCandidate("packages/view/src/web/button.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "web button view", {
      getGitPrior: (candidate) =>
        candidate.relativePath === "packages/view/src/web/button.ts" ? 80 : 0,
    });

    expect(ranked[0]?.relativePath).toBe("packages/web/src/button-view.ts");
  });

  test("boosts files near the active file", () => {
    const candidates = [
      createCandidate("src/search/cache.ts"),
      createCandidate("test/search/cache.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "cache", {
      activePath: "src/search/index.ts",
    });

    expect(ranked[0]?.relativePath).toBe("src/search/cache.ts");
  });

  test("uses frecency only when the query is empty", () => {
    const candidates = [
      createCandidate("src/recent/button.ts"),
      createCandidate("src/current/button.ts"),
    ];

    const ranked = scoreSearchCandidates(candidates, "", {
      activePath: "src/current/button.ts",
      openPaths: new Set(["src/current/button.ts"]),
      getFrecencyScore: (relativePath) => (relativePath === "src/recent/button.ts" ? 4 : 0),
      getGitPrior: () => 8,
      getGitTrackingState: () => "tracked",
    });

    expect(ranked[0]?.candidate.relativePath).toBe("src/recent/button.ts");
    expect(ranked[0]?.breakdown.context.contributions.map(({ label }) => label)).toEqual([
      "frecency",
    ]);
    expect(ranked[1]?.breakdown.context.contributions).toEqual([]);
    expect(ranked[0]?.breakdown.gitPrior.total).toBe(0);
  });

  test("leans more on frecency for one-character queries than three-character queries", () => {
    const candidates = [
      createCandidate("src/recent/button.ts"),
      createCandidate("src/current/button.ts"),
    ];
    const context = {
      activePath: "src/current/button.ts",
      openPaths: new Set(["src/current/button.ts"]),
      getFrecencyScore: (relativePath: string) => (relativePath === "src/recent/button.ts" ? 4 : 0),
      getGitPrior: (candidate: SearchCandidate) =>
        candidate.relativePath === "src/current/button.ts" ? 4 : 0,
      getGitTrackingState: () => "tracked" as const,
    };

    const oneCharacterRanked = rankSearchCandidates(candidates, "b", context);
    const threeCharacterRanked = rankSearchCandidates(candidates, "but", context);

    expect(oneCharacterRanked[0]?.relativePath).toBe("src/recent/button.ts");
    expect(threeCharacterRanked[0]?.relativePath).toBe("src/current/button.ts");
  });

  test("boosts files in the active package for ambiguous queries", () => {
    const candidates = [
      createCandidate(
        "packages/libraries/native/mobile-picasso/src/components/Button/index.tsx",
        "packages/libraries/native/mobile-picasso",
      ),
      createCandidate(
        "packages/libraries/web/web-picasso/src/components/Button/index.tsx",
        "packages/libraries/web/web-picasso",
      ),
    ];

    const ranked = rankSearchCandidates(candidates, "index", {
      activePackageRoot: "packages/libraries/native/mobile-picasso",
    });

    expect(ranked[0]?.relativePath).toBe(
      "packages/libraries/native/mobile-picasso/src/components/Button/index.tsx",
    );
  });

  test("significantly down ranks untracked files", () => {
    const candidates = [
      createCandidate("src/tracked/config.ts"),
      createCandidate("scratch/config.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "config", {
      getGitTrackingState: (candidate) =>
        candidate.relativePath === "src/tracked/config.ts" ? "tracked" : "untracked",
    });

    expect(ranked[0]?.relativePath).toBe("src/tracked/config.ts");
  });

  test("down ranks ignored files even more aggressively", () => {
    const candidates = [createCandidate("src/tracked/config.ts"), createCandidate("tmp/config.ts")];

    const ranked = rankSearchCandidates(candidates, "config", {
      getGitTrackingState: (candidate) =>
        candidate.relativePath === "src/tracked/config.ts" ? "tracked" : "ignored",
    });

    expect(ranked[0]?.relativePath).toBe("src/tracked/config.ts");
  });

  test("exposes numeric scores for ranked candidates", () => {
    const candidates = [
      createCandidate("src/tracked/config.ts"),
      createCandidate("src/core/settings.ts"),
    ];

    const ranked = scoreSearchCandidates(candidates, "config");

    expect(ranked[0]?.candidate.relativePath).toBe("src/tracked/config.ts");
    expect(ranked[0]?.total).toBeGreaterThan(ranked[1]?.total ?? 0);
  });

  test("collects matched candidates without changing default ranking order", () => {
    const candidates = [
      createCandidate("src/tracked/config.ts"),
      createCandidate("src/core/config.ts"),
      createCandidate("src/core/settings.ts"),
    ];

    const collected = collectRankedSearchCandidates(candidates, "config", {
      getFrecencyScore: (relativePath) => (relativePath === "src/core/config.ts" ? 4 : 0),
    });
    const scored = scoreSearchCandidates(candidates, "config", {
      getFrecencyScore: (relativePath) => (relativePath === "src/core/config.ts" ? 4 : 0),
    });

    expect(collected.matchedCandidates.map((candidate) => candidate.relativePath)).toEqual([
      "src/tracked/config.ts",
      "src/core/config.ts",
    ]);
    expect(collected.rankedCandidates.map((candidate) => candidate.relativePath)).toEqual(
      scored.map(({ candidate }) => candidate.relativePath),
    );
  });

  test("captures score breakdown data for debug display", () => {
    const candidates = [createCandidate("src/search/config.ts")];

    const ranked = scoreSearchCandidates(candidates, "config", {
      activePath: "src/search/index.ts",
      openPaths: new Set(["src/search/config.ts"]),
      getFrecencyScore: () => 8,
      getGitPrior: () => 6,
      getGitTrackingState: () => "tracked",
    });

    expect(ranked[0]?.breakdown.lexical.tokenMatches[0]).toEqual({
      token: "config",
      kind: "basenamePrefix",
      score: 5_091,
    });
    expect(ranked[0]?.breakdown.context.contributions).toEqual([
      { label: "frecency", score: 349 },
      { label: "tracked", score: 80 },
      { label: "open", score: 120 },
      { label: "same-dir", score: 90 },
    ]);
    expect(ranked[0]?.breakdown.gitPrior.rawPrior).toBe(6);
    expect(ranked[0]?.breakdown.gitPrior.total).toBeGreaterThan(0);
  });

  test("uses configured ranking weights", () => {
    const candidates = [
      createCandidate("src/features/history-index.ts"),
      createCandidate("src/history/index.ts"),
    ];

    const ranked = rankSearchCandidates(candidates, "history", {}, 200, {
      ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking,
      lexical: {
        ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.ranking.lexical,
        pathBoundaryScore: 6000,
        basenamePrefixScore: 1000,
        basenameSubstringScore: 500,
      },
    });

    expect(ranked[0]?.relativePath).toBe("src/history/index.ts");
  });
});

describe("gitignored visibility", () => {
  test("auto hides ignored files for broad queries", () => {
    expect(shouldIncludeGitignoredFile("", "auto")).toBe(false);
    expect(shouldIncludeGitignoredFile("tmp", "auto")).toBe(false);
    expect(shouldIncludeGitignoredFile("test", "auto")).toBe(false);
    expect(shouldIncludeGitignoredFile("mobile button", "auto")).toBe(false);
    expect(shouldIncludeGitignoredFile("src/button.tsx", "auto")).toBe(false);
  });

  test("auto only shows ignored files for exact basename queries with an extension", () => {
    expect(isSpecificQuery("config")).toBe(false);
    expect(isSpecificQuery("longfilename12")).toBe(false);
    expect(isSpecificQuery(".env.local")).toBe(true);
    expect(isSpecificQuery("Button.swift")).toBe(true);
    expect(isSpecificQuery("foo bar")).toBe(false);
    expect(shouldIncludeGitignoredFile("config", "auto")).toBe(false);
    expect(shouldIncludeGitignoredFile(".env.local", "auto")).toBe(true);
    expect(shouldIncludeGitignoredFile("button.component.tsx", "auto")).toBe(true);
  });

  test("show and hide modes are explicit", () => {
    expect(shouldIncludeGitignoredFile("", "show")).toBe(true);
    expect(shouldIncludeGitignoredFile("config", "hide")).toBe(false);
  });

  test("underscore and hyphen no longer trigger path separator reveal", () => {
    expect(isSpecificQuery("btn-view")).toBe(false);
    expect(isSpecificQuery("my_file")).toBe(false);
    expect(isSpecificQuery("src/btn")).toBe(false);
    expect(isSpecificQuery("conf.ts")).toBe(true);
  });

  test("auto config shape no longer widens ignored-file visibility", () => {
    expect(isSpecificQuery("abcd")).toBe(false);
    expect(
      shouldIncludeGitignoredFile("foo bar baz", {
        visibility: "auto",
        auto: {
          minQueryLength: 1,
          minTokenCount: 1,
          revealOnPathSeparator: true,
        },
      }),
    ).toBe(false);
  });
});
