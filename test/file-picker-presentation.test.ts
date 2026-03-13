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
        isReadyForPicker: true,
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
        isReadyForPicker: true,
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
        isReadyForPicker: true,
        query: "src",
      }),
    ).toBeUndefined();

    expect(
      getPendingFilePickerItem({
        currentSource: "live",
        hasEntries: false,
        isIndexing: false,
        isRestoringSnapshot: false,
        isReadyForPicker: true,
        query: "src",
      }),
    ).toBeUndefined();
  });

  test("keeps cached entries hidden until picker metadata is ready", () => {
    expect(
      getPendingFilePickerItem({
        currentSource: "cache",
        hasEntries: true,
        isIndexing: true,
        isRestoringSnapshot: false,
        isReadyForPicker: false,
        query: "button",
      }),
    ).toEqual({
      label: "Searching workspace files...",
      description: "Preparing tracked file metadata before showing cached results.",
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
