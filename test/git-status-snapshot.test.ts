import { describe, expect, test } from "bun:test";
import { parseGitStatusSnapshot } from "../src/workspace/git-status-snapshot";

describe("parseGitStatusSnapshot", () => {
  test("parses branch metadata and changed path groups from porcelain v2 output", () => {
    const snapshot = parseGitStatusSnapshot(
      [
        "# branch.oid abcdef",
        "# branch.head main",
        "# branch.upstream origin/main",
        "1 M. N... 100644 100644 100644 aaa bbb src/path with spaces.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.ts",
        "src/old-name.ts",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicted.ts",
        "? notes/draft.ts",
        "! ignored/",
        "! tmp/cache.log",
        "",
      ].join("\u0000"),
    );

    expect(snapshot.headCommit).toBe("abcdef");
    expect(snapshot.upstreamRef).toBe("origin/main");
    expect(snapshot.stagedPaths).toEqual([
      "src/path with spaces.ts",
      "src/new-name.ts",
      "src/conflicted.ts",
    ]);
    expect(snapshot.modifiedPaths).toEqual(["src/conflicted.ts"]);
    expect(snapshot.untrackedPaths).toEqual(["notes/draft.ts"]);
    expect([...snapshot.ignoredPaths]).toEqual(["tmp/cache.log"]);
    expect(snapshot.ignoredDirectoryPrefixes).toEqual(["ignored/"]);
  });
});
