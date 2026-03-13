import { describe, expect, test } from "bun:test";
import {
  formatFilePickerTitle,
  getPendingFilePickerItem,
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
        query: "src",
      }),
    ).toBeUndefined();

    expect(
      getPendingFilePickerItem({
        currentSource: "live",
        hasEntries: false,
        isIndexing: false,
        isRestoringSnapshot: false,
        query: "src",
      }),
    ).toBeUndefined();
  });
});
