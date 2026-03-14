import { describe, expect, test } from "bun:test";
import { resolveThemeIconMatch } from "../src/icons/icon-matcher";

describe("resolveThemeIconMatch", () => {
  test("prefers explicit file extension matches over the default file icon", () => {
    const match = resolveThemeIconMatch(createEntry("src/button.tsx"), {
      defaultFileIconId: "file",
      fileExtensions: new Map([["tsx", "react_ts"]]),
      fileNames: new Map(),
      languageIds: new Map([["typescriptreact", "react_ts"]]),
      overrides: [],
      resolveLanguageId: () => "typescriptreact",
    });

    expect(match).toEqual({
      iconId: "react_ts",
      kind: "specific",
      source: "fileExtensions",
    });
  });

  test("matches the longest multipart extension first", () => {
    const match = resolveThemeIconMatch(createEntry("types/button.d.ts"), {
      defaultFileIconId: "file",
      fileExtensions: new Map([
        ["ts", "typescript"],
        ["d.ts", "typescript-def"],
      ]),
      fileNames: new Map(),
      languageIds: new Map([["typescript", "typescript"]]),
      overrides: [],
      resolveLanguageId: () => "typescript",
    });

    expect(match).toEqual({
      iconId: "typescript-def",
      kind: "specific",
      source: "fileExtensions",
    });
  });

  test("returns a default-file match when no specific association exists", () => {
    const match = resolveThemeIconMatch(createEntry("src/button.js"), {
      defaultFileIconId: "file",
      fileExtensions: new Map([
        ["tsx", "react_ts"],
        ["d.ts", "typescript-def"],
      ]),
      fileNames: new Map(),
      languageIds: new Map(),
      overrides: [],
      resolveLanguageId: () => undefined,
    });

    expect(match).toEqual({
      iconId: "file",
      kind: "default",
      source: "file",
    });
  });

  test("uses language id associations when no file association exists", () => {
    const match = resolveThemeIconMatch(createEntry("src/button.ts"), {
      defaultFileIconId: "file",
      fileExtensions: new Map(),
      fileNames: new Map(),
      languageIds: new Map([["typescript", "typescript"]]),
      overrides: [],
      resolveLanguageId: () => "typescript",
    });

    expect(match).toEqual({
      iconId: "typescript",
      kind: "specific",
      source: "languageIds",
      languageId: "typescript",
    });
  });
});

function createEntry(relativePath: string) {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const directory = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";

  return {
    basename,
    directory,
    identityPath: relativePath,
    relativePath,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
    uri: {
      fsPath: `/tmp/${relativePath}`,
      path: `/tmp/${relativePath}`,
      scheme: "file",
    },
  } as Parameters<typeof resolveThemeIconMatch>[0];
}
