import { describe, expect, test } from "bun:test";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG } from "../src/config/schema";
import { isSpecificQuery, shouldIncludeGitignoredFile } from "../src/search/gitignored-visibility";
import {
  rankSearchCandidates,
  scoreSearchCandidates,
  type SearchCandidate,
} from "../src/search/search-ranking";

function createCandidate(relativePath: string): SearchCandidate {
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];
  const directory = segments.slice(0, -1).join("/");

  return {
    basename,
    relativePath,
    directory,
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
  });

  test("auto shows ignored files for specific queries", () => {
    expect(isSpecificQuery("config")).toBe(true);
    expect(isSpecificQuery(".env.local")).toBe(true);
    expect(isSpecificQuery("foo bar")).toBe(true);
    expect(shouldIncludeGitignoredFile("config", "auto")).toBe(true);
    expect(shouldIncludeGitignoredFile(".env.local", "auto")).toBe(true);
  });

  test("show and hide modes are explicit", () => {
    expect(shouldIncludeGitignoredFile("", "show")).toBe(true);
    expect(shouldIncludeGitignoredFile("config", "hide")).toBe(false);
  });

  test("specific query thresholds are configurable", () => {
    expect(
      isSpecificQuery("abcd", {
        minQueryLength: 6,
        minTokenCount: 3,
        revealOnPathSeparator: false,
      }),
    ).toBe(false);
    expect(
      shouldIncludeGitignoredFile("foo bar baz", {
        visibility: "auto",
        auto: {
          minQueryLength: 6,
          minTokenCount: 3,
          revealOnPathSeparator: false,
        },
      }),
    ).toBe(true);
  });
});
