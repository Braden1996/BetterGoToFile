import { describe, expect, test } from "bun:test";
import { DEFAULT_BETTER_GO_TO_FILE_CONFIG } from "../src/config/schema";
import { searchFileItems } from "../src/search/file-search";

describe("searchFileItems icons", () => {
  test("uses resourceUri when no custom icon is resolved", () => {
    const entry = createEntry("src/button.ts");
    const result = searchFileItems(
      [entry],
      "button",
      {},
      () => undefined,
      undefined,
      DEFAULT_BETTER_GO_TO_FILE_CONFIG,
    );

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.resourceUri?.fsPath).toBe(entry.uri.fsPath);
    expect(result.items[0]?.iconPath).toBeUndefined();
  });

  test("keeps custom icon paths when one is resolved", () => {
    const entry = createEntry("src/button.tsx");
    const customIcon = { id: "custom-icon" };
    const result = searchFileItems(
      [entry],
      "button",
      {},
      () => customIcon,
      undefined,
      DEFAULT_BETTER_GO_TO_FILE_CONFIG,
    );

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.iconPath).toBe(customIcon);
    expect(result.items[0]?.resourceUri).toBeUndefined();
  });
});

function createEntry(relativePath: string) {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const directory = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";

  return {
    uri: {
      fsPath: `/tmp/${relativePath}`,
      path: `/tmp/${relativePath}`,
      scheme: "file",
    },
    basename,
    relativePath,
    identityPath: relativePath,
    directory,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  } as Parameters<typeof searchFileItems>[0][number];
}
