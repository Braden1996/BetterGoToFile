import type { FileEntry } from "../workspace";
import {
  findFileIconOverride,
  findMatchingAssociation,
  findMatchingAssociationInOverrides,
} from "./icon-theme-parser";
import type { IconThemeOverride } from "./types";

export type ThemeIconMatchSource =
  | "override.fileNames"
  | "fileNames"
  | "override.fileExtensions"
  | "fileExtensions"
  | "override.languageIds"
  | "languageIds"
  | "override.file"
  | "file";

export interface ThemeIconMatch {
  readonly iconId: string;
  readonly kind: "specific" | "default";
  readonly source: ThemeIconMatchSource;
  readonly languageId?: string;
}

export function resolveThemeIconMatch(
  entry: FileEntry,
  options: {
    readonly defaultFileIconId?: string;
    readonly fileExtensions: ReadonlyMap<string, string>;
    readonly fileNames: ReadonlyMap<string, string>;
    readonly languageIds: ReadonlyMap<string, string>;
    readonly overrides: readonly IconThemeOverride[];
    readonly resolveLanguageId?: (entry: FileEntry) => string | undefined;
  },
): ThemeIconMatch | undefined {
  const fileNameCandidates = buildFileNameCandidates(entry);
  const extensionCandidates = buildExtensionCandidates(entry);

  const overrideFileNameMatch = findMatchingAssociationInOverrides(
    options.overrides,
    "fileNames",
    fileNameCandidates,
  );

  if (overrideFileNameMatch) {
    return {
      iconId: overrideFileNameMatch,
      kind: "specific",
      source: "override.fileNames",
    };
  }

  const fileNameMatch = findMatchingAssociation(options.fileNames, fileNameCandidates);

  if (fileNameMatch) {
    return {
      iconId: fileNameMatch,
      kind: "specific",
      source: "fileNames",
    };
  }

  const overrideExtensionMatch = findMatchingAssociationInOverrides(
    options.overrides,
    "fileExtensions",
    extensionCandidates,
  );

  if (overrideExtensionMatch) {
    return {
      iconId: overrideExtensionMatch,
      kind: "specific",
      source: "override.fileExtensions",
    };
  }

  const extensionMatch = findMatchingAssociation(options.fileExtensions, extensionCandidates);

  if (extensionMatch) {
    return {
      iconId: extensionMatch,
      kind: "specific",
      source: "fileExtensions",
    };
  }

  const resolvedLanguageId = options.resolveLanguageId?.(entry)?.toLowerCase();

  if (resolvedLanguageId) {
    const overrideLanguageMatch = findMatchingAssociationInOverrides(
      options.overrides,
      "languageIds",
      [resolvedLanguageId],
    );

    if (overrideLanguageMatch) {
      return {
        iconId: overrideLanguageMatch,
        kind: "specific",
        source: "override.languageIds",
        languageId: resolvedLanguageId,
      };
    }

    const languageMatch = findMatchingAssociation(options.languageIds, [resolvedLanguageId]);

    if (languageMatch) {
      return {
        iconId: languageMatch,
        kind: "specific",
        source: "languageIds",
        languageId: resolvedLanguageId,
      };
    }
  }

  const overrideFileIconId = findFileIconOverride(options.overrides);

  if (overrideFileIconId) {
    return {
      iconId: overrideFileIconId,
      kind: "default",
      source: "override.file",
    };
  }

  if (options.defaultFileIconId) {
    return {
      iconId: options.defaultFileIconId,
      kind: "default",
      source: "file",
    };
  }

  return undefined;
}

function buildFileNameCandidates(entry: FileEntry): string[] {
  const pathSegments = entry.searchPath.split("/").filter(Boolean);
  const candidates = new Set<string>();

  candidates.add(entry.searchBasename);
  candidates.add(entry.searchPath);

  for (let index = 1; index < pathSegments.length; index += 1) {
    candidates.add(pathSegments.slice(index).join("/"));
  }

  return [...candidates].sort((left, right) => right.length - left.length);
}

function buildExtensionCandidates(entry: FileEntry): string[] {
  const candidates: string[] = [];
  const basename = entry.searchBasename;

  for (let index = basename.indexOf("."); index >= 0; index = basename.indexOf(".", index + 1)) {
    const candidate = basename.slice(index + 1);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}
