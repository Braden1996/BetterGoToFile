import { describe, expect, test } from "bun:test";
import {
  shouldReusePersistedGitState,
  type GitStateValidation,
} from "../src/workspace/git-tracked-index-cache";
import { mergeGitRefreshRequests, type GitRefreshRequest } from "../src/workspace/git-refresh-plan";

describe("mergeGitRefreshRequests", () => {
  test("unions folder-scoped overlay refreshes", () => {
    const merged = mergeGitRefreshRequests(
      {
        kind: "overlay",
        workspaceFolderPaths: ["/repo-a"],
      },
      {
        kind: "overlay",
        workspaceFolderPaths: ["/repo-b"],
      },
    );

    expect(merged).toEqual({
      kind: "overlay",
      workspaceFolderPaths: ["/repo-a", "/repo-b"],
    } satisfies GitRefreshRequest);
  });

  test("promotes the merged kind to full when needed", () => {
    const merged = mergeGitRefreshRequests(
      {
        kind: "overlay",
        workspaceFolderPaths: ["/repo-a"],
      },
      {
        kind: "full",
        workspaceFolderPaths: ["/repo-b"],
      },
    );

    expect(merged).toEqual({
      kind: "full",
      workspaceFolderPaths: ["/repo-a", "/repo-b"],
    } satisfies GitRefreshRequest);
  });

  test("lets workspace-wide refreshes override folder-scoped requests", () => {
    const merged = mergeGitRefreshRequests(
      {
        kind: "overlay",
        workspaceFolderPaths: ["/repo-a"],
      },
      {
        kind: "full",
      },
    );

    expect(merged).toEqual({
      kind: "full",
    } satisfies GitRefreshRequest);
  });
});

describe("shouldReusePersistedGitState", () => {
  test("reuses cached Git state when head and index still match", () => {
    const validation: GitStateValidation = {
      headCommit: "abc123",
      indexStamp: "1024:55",
    };

    expect(shouldReusePersistedGitState(validation, validation)).toBe(true);
  });

  test("invalidates cached Git state when head changes", () => {
    expect(
      shouldReusePersistedGitState(
        {
          headCommit: "abc123",
          indexStamp: "1024:55",
        },
        {
          headCommit: "def456",
          indexStamp: "1024:55",
        },
      ),
    ).toBe(false);
  });

  test("invalidates cached Git state when the index changes", () => {
    expect(
      shouldReusePersistedGitState(
        {
          headCommit: "abc123",
          indexStamp: "1024:55",
        },
        {
          headCommit: "abc123",
          indexStamp: "1025:55",
        },
      ),
    ).toBe(false);
  });
});
