import { describe, expect, test } from "bun:test";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG } from "../src/config/schema";
import { buildFilePickDescription } from "../src/search/file-pick-description";
import type { FileEntry } from "../src/workspace/file-entry";

describe("buildFilePickDescription", () => {
  test("preserves the package directory when truncating to the tail", () => {
    const description = buildFilePickDescription(
      createEntry("packages/design-system/src/tasks/button.tsx", "packages/design-system"),
      "",
      "tracked",
      {
        ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
        pathTailSegments: 1,
        collapsedTailSegments: 1,
        queryContextRadius: 0,
        maxRowWidthUnits: 12,
        labelPaddingWidthUnits: 0,
        minDescriptionWidthUnits: 1,
      },
    );

    expect(description).toBe("…/design-system/…/tasks");
  });

  test("falls back to a plain tail when the file is not inside a package", () => {
    const description = buildFilePickDescription(
      createEntry("packages/design-system/src/tasks/button.tsx"),
      "",
      "tracked",
      {
        ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
        pathTailSegments: 1,
        collapsedTailSegments: 1,
        queryContextRadius: 0,
        maxRowWidthUnits: 12,
        labelPaddingWidthUnits: 0,
        minDescriptionWidthUnits: 1,
      },
    );

    expect(description).toBe("…/tasks");
  });
});

function createEntry(relativePath: string, packageRoot?: string): FileEntry {
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1] ?? "";
  const directory = segments.slice(0, -1).join("/");

  return {
    uri: undefined as never,
    basename,
    relativePath,
    directory,
    packageRoot,
    workspaceFolderName: undefined,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  };
}
