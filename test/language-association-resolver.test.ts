import { describe, expect, test } from "bun:test";
import { createLanguageAssociationResolver } from "../src/icons/language-association-resolver";

describe("createLanguageAssociationResolver", () => {
  test("resolves extension-backed languages", () => {
    const resolver = createLanguageAssociationResolver({
      contributions: [
        {
          id: "typescript",
          extensions: [".ts", ".cts", ".mts"],
          filenames: [],
          filenamePatterns: [],
        },
      ],
    });

    expect(resolver.resolve(createEntry("src/button.ts"))).toBe("typescript");
  });

  test("matches filename patterns against basenames when the pattern has no path segments", () => {
    const resolver = createLanguageAssociationResolver({
      contributions: [
        {
          id: "dockercompose",
          extensions: [],
          filenames: [],
          filenamePatterns: ["compose.*.yml", "compose.*.yaml"],
        },
      ],
    });

    expect(resolver.resolve(createEntry("infra/compose.dev.yml"))).toBe("dockercompose");
  });

  test("lets configured file associations override contributed extensions", () => {
    const resolver = createLanguageAssociationResolver({
      configuredAssociations: [
        {
          pattern: "*.ts",
          languageId: "plaintext",
        },
      ],
      contributions: [
        {
          id: "typescript",
          extensions: [".ts"],
          filenames: [],
          filenamePatterns: [],
        },
      ],
    });

    expect(resolver.resolve(createEntry("src/button.ts"))).toBe("plaintext");
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
  } as Parameters<ReturnType<typeof createLanguageAssociationResolver>["resolve"]>[0];
}
