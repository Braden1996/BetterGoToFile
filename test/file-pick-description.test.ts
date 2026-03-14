import { describe, expect, test } from "bun:test";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG } from "../src/config/schema";
import {
  buildFilePickDescription,
  buildFilePickPresentation,
} from "../src/search/file-pick-description";
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

describe("buildFilePickPresentation", () => {
  test("keeps the full directory when a truncated label makes it fit", () => {
    const presentation = buildFilePickPresentation(
      createEntry("src/features/some-very-long-generated-component-name-for-picker-layout.tsx"),
      "",
      "tracked",
      {
        ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
        pathTailSegments: 2,
        collapsedTailSegments: 1,
        queryContextRadius: 0,
        maxRowWidthUnits: 38,
        labelPaddingWidthUnits: 2,
        minDescriptionWidthUnits: 1,
      },
    );

    expect(presentation.description).toBe("src/features");
    expect(presentation.label).toContain("…");
  });

  test("truncates oversized basenames in the middle", () => {
    const presentation = buildFilePickPresentation(
      createEntry(
        "migrations/1764161620065_add_active-sequence-permission-by-target-index.migration.ts",
      ),
      "",
      "tracked",
      {
        ...DEFAULT_BETTER_GO_TO_FILE_CONFIG.picker.description,
        pathTailSegments: 1,
        collapsedTailSegments: 1,
        queryContextRadius: 0,
        maxRowWidthUnits: 18,
        labelPaddingWidthUnits: 0,
        minDescriptionWidthUnits: 1,
      },
    );

    expect(presentation.label).toContain("…");
    expect(presentation.label.endsWith(".ts")).toBe(true);
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
    identityPath: relativePath,
    directory,
    packageRoot,
    packageRootIdentity: packageRoot,
    workspaceFolderPath: undefined,
    workspaceFolderName: undefined,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  };
}
