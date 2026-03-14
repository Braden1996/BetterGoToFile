import type { FileEntry } from "../workspace";
import { createPathGlobMatcher, type PathGlobMatcher } from "../workspace/path-glob";

export interface LanguageAssociationResolver {
  resolve(entry: FileEntry): string | undefined;
}

export interface LanguageContributionData {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly filenames: readonly string[];
  readonly filenamePatterns: readonly string[];
}

export interface FileAssociationData {
  readonly pattern: string;
  readonly languageId: string;
}

interface PatternAssociation {
  readonly languageId: string;
  readonly target: "basename" | "path";
  readonly matcher: PathGlobMatcher;
}

export function createLanguageAssociationResolver(options: {
  readonly contributions: readonly LanguageContributionData[];
  readonly configuredAssociations?: readonly FileAssociationData[];
}): LanguageAssociationResolver {
  return new ConfiguredLanguageAssociationResolver(options);
}

class ConfiguredLanguageAssociationResolver implements LanguageAssociationResolver {
  private readonly configuredFileNames = new Map<string, string>();
  private readonly configuredPatterns: PatternAssociation[] = [];
  private readonly fileExtensions = new Map<string, string>();
  private readonly fileNames = new Map<string, string>();
  private readonly fileNamePatterns: PatternAssociation[] = [];
  private readonly resolvedLanguageCache = new Map<string, string | null>();

  constructor(options: {
    readonly contributions: readonly LanguageContributionData[];
    readonly configuredAssociations?: readonly FileAssociationData[];
  }) {
    for (const association of options.configuredAssociations ?? []) {
      this.registerConfiguredAssociation(association);
    }

    for (const contribution of options.contributions) {
      this.registerContribution(contribution);
    }
  }

  resolve(entry: FileEntry): string | undefined {
    const cachedLanguageId = this.resolvedLanguageCache.get(entry.searchPath);

    if (cachedLanguageId !== undefined) {
      return cachedLanguageId ?? undefined;
    }

    const languageId =
      this.configuredFileNames.get(entry.searchBasename) ??
      findMatchingPatternAssociation(this.configuredPatterns, entry) ??
      this.fileNames.get(entry.searchBasename) ??
      findMatchingPatternAssociation(this.fileNamePatterns, entry) ??
      findMatchingExtensionAssociation(this.fileExtensions, entry);

    this.resolvedLanguageCache.set(entry.searchPath, languageId ?? null);

    return languageId;
  }

  private registerConfiguredAssociation(association: FileAssociationData): void {
    const pattern = association.pattern.toLowerCase();
    const languageId = association.languageId.toLowerCase();

    if (isExactBasenameAssociation(pattern)) {
      this.configuredFileNames.set(pattern, languageId);
      return;
    }

    this.configuredPatterns.push(createPatternAssociation(pattern, languageId));
  }

  private registerContribution(contribution: LanguageContributionData): void {
    const languageId = contribution.id.toLowerCase();

    for (const filename of contribution.filenames) {
      this.fileNames.set(filename.toLowerCase(), languageId);
    }

    for (const pattern of contribution.filenamePatterns) {
      this.fileNamePatterns.push(createPatternAssociation(pattern.toLowerCase(), languageId));
    }

    for (const extension of contribution.extensions) {
      this.fileExtensions.set(extension.toLowerCase(), languageId);
    }
  }
}

function isExactBasenameAssociation(pattern: string): boolean {
  return !/[?*{}]/.test(pattern) && !pattern.includes("/");
}

function createPatternAssociation(pattern: string, languageId: string): PatternAssociation {
  return {
    languageId,
    target: pattern.includes("/") ? "path" : "basename",
    matcher: createPathGlobMatcher(pattern),
  };
}

function findMatchingPatternAssociation(
  patterns: readonly PatternAssociation[],
  entry: FileEntry,
): string | undefined {
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    const candidate = pattern.target === "path" ? entry.searchPath : entry.searchBasename;

    if (pattern.matcher(candidate)) {
      return pattern.languageId;
    }
  }

  return undefined;
}

function findMatchingExtensionAssociation(
  associations: ReadonlyMap<string, string>,
  entry: FileEntry,
): string | undefined {
  for (const candidate of buildExtensionCandidates(entry)) {
    const languageId = associations.get(candidate);

    if (languageId) {
      return languageId;
    }
  }

  return undefined;
}

function buildExtensionCandidates(entry: FileEntry): string[] {
  const candidates: string[] = [];
  const basename = entry.searchBasename;

  for (let index = basename.indexOf("."); index >= 0; index = basename.indexOf(".", index + 1)) {
    const candidate = basename.slice(index);

    if (candidate.length > 1) {
      candidates.push(candidate);
    }
  }

  return candidates;
}
