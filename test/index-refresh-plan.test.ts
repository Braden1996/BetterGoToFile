import { describe, expect, test } from "bun:test";
import {
  mergeWorkspaceIndexRefreshRequests,
  type WorkspaceIndexRefreshRequest,
} from "../src/workspace/index-refresh-plan";

describe("workspace index refresh plan", () => {
  test("keeps full refresh requests as the sole queued item", () => {
    const queue: WorkspaceIndexRefreshRequest[] = [
      {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src",
      },
    ];

    expect(mergeWorkspaceIndexRefreshRequests(queue, { kind: "full" })).toEqual([{ kind: "full" }]);
  });

  test("drops narrower partial refreshes when an ancestor is already queued", () => {
    const queue: WorkspaceIndexRefreshRequest[] = [
      {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src",
      },
    ];

    expect(
      mergeWorkspaceIndexRefreshRequests(queue, {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src/components",
      }),
    ).toEqual(queue);
  });

  test("replaces narrower partial refreshes when a broader ancestor arrives", () => {
    const queue: WorkspaceIndexRefreshRequest[] = [
      {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src/components",
      },
      {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src/hooks",
      },
    ];

    expect(
      mergeWorkspaceIndexRefreshRequests(queue, {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src",
      }),
    ).toEqual([
      {
        kind: "partial",
        workspaceFolderPath: "/workspace",
        relativeDirectory: "src",
      },
    ]);
  });

  test("keeps unrelated workspace folder refreshes independent", () => {
    const queue: WorkspaceIndexRefreshRequest[] = [
      {
        kind: "partial",
        workspaceFolderPath: "/workspace-a",
        relativeDirectory: "src",
      },
    ];

    expect(
      mergeWorkspaceIndexRefreshRequests(queue, {
        kind: "partial",
        workspaceFolderPath: "/workspace-b",
        relativeDirectory: "src",
      }),
    ).toEqual([
      {
        kind: "partial",
        workspaceFolderPath: "/workspace-a",
        relativeDirectory: "src",
      },
      {
        kind: "partial",
        workspaceFolderPath: "/workspace-b",
        relativeDirectory: "src",
      },
    ]);
  });
});
