import { describe, expect, test } from "bun:test";
import {
  formatFilePickerTitle,
  getPendingFilePickerItem,
  shouldLockFilePickerEntries,
} from "../src/app/commands/file-picker-presentation";

describe("file picker presentation", () => {
  test("shows a searching title while picker work is in progress", () => {
    expect(formatFilePickerTitle(true)).toBe("Better Go To File - Searching...");
    expect(formatFilePickerTitle(false)).toBe("Better Go To File");
  });

  test("shows a loading row while the index is still warming up", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "empty",
        hasEntries: false,
        isIndexing: true,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({ isReady: true }),
        query: "",
      }),
    ).toEqual({
      label: "Loading workspace files...",
      description: "Results will appear as the workspace index becomes ready.",
      alwaysShow: true,
    });
  });

  test("describes cached results while a live refresh is still running", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "cache",
        hasEntries: false,
        isIndexing: true,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({ isReady: true }),
        query: "src/search",
      }),
    ).toEqual({
      label: "Searching workspace files...",
      description: "Showing cached results as the live index refreshes.",
      alwaysShow: true,
    });
  });

  test("does not show a loading row once entries are available or indexing is idle", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "live",
        hasEntries: true,
        isIndexing: true,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({ isReady: true }),
        query: "src",
      }),
    ).toBeUndefined();

    expect(
      getPendingFilePickerItem({
        currentSource: "live",
        hasEntries: false,
        isIndexing: false,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({ isReady: true }),
        query: "src",
      }),
    ).toBeUndefined();
  });

  test("keeps cached entries hidden while specific ranking inputs are still loading", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "cache",
        hasEntries: true,
        isIndexing: true,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({
          isReady: false,
          isGitTrackingReady: false,
          isContributorRelationshipsReady: false,
        }),
        query: "button",
      }),
    ).toEqual({
      label: "Searching workspace files...",
      description: "Waiting for Git status and contributor history before showing cached results.",
      alwaysShow: true,
    });
  });

  test("lists all pending ranking inputs while the picker is still warming up", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "empty",
        hasEntries: false,
        isIndexing: true,
        isRestoringSnapshot: false,
        pickerReadiness: createPickerReadiness({
          isReady: false,
          isWorkspaceIndexReady: false,
          isFrecencyReady: false,
          isGitTrackingReady: false,
          isContributorRelationshipsReady: false,
        }),
        query: "",
      }),
    ).toEqual({
      label: "Loading workspace files...",
      description:
        "Waiting for workspace index, recent visits, Git status, and contributor history.",
      alwaysShow: true,
    });
  });

  test("keeps cached entries unlocked while the live refresh is still running", () => {
    expect(
      shouldLockFilePickerEntries({
        currentSource: "cache",
        hasEntries: true,
        isIndexing: true,
        isRestoringSnapshot: false,
      }),
    ).toBe(false);
  });

  test("locks entries once live results are available", () => {
    expect(
      shouldLockFilePickerEntries({
        currentSource: "live",
        hasEntries: true,
        isIndexing: false,
        isRestoringSnapshot: false,
      }),
    ).toBe(true);
  });
});

function createPickerReadiness(
  overrides: Partial<{
    isReady: boolean;
    isWorkspaceIndexReady: boolean;
    isFrecencyReady: boolean;
    isGitTrackingReady: boolean;
    isContributorRelationshipsReady: boolean;
  }> = {},
): {
  isReady: boolean;
  isWorkspaceIndexReady: boolean;
  isFrecencyReady: boolean;
  isGitTrackingReady: boolean;
  isContributorRelationshipsReady: boolean;
} {
  return {
    isReady: true,
    isWorkspaceIndexReady: true,
    isFrecencyReady: true,
    isGitTrackingReady: true,
    isContributorRelationshipsReady: true,
    ...overrides,
  };
}
