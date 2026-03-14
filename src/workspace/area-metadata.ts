import * as path from "node:path";
import { collectPackageRootDirectories, findNearestPackageRoot } from "./package-root";

const AREA_ANCESTOR_DECAY = 0.5;
const AREA_SUBTREE_DILUTION_EXPONENT = 0.5;

export interface AreaMetadata {
  readonly packageRootDirectories: ReadonlySet<string>;
  readonly subtreeFileCounts: ReadonlyMap<string, number>;
}

export function buildAreaMetadata(
  relativePaths: readonly string[],
  packageRootDirectories: ReadonlySet<string> = collectPackageRootDirectories(relativePaths),
): AreaMetadata {
  const subtreeFileCounts = new Map<string, number>();
  const seenPaths = new Set<string>();

  for (const relativePath of relativePaths) {
    const normalizedRelativePath = normalizeRelativePath(relativePath);

    if (!normalizedRelativePath || seenPaths.has(normalizedRelativePath)) {
      continue;
    }

    seenPaths.add(normalizedRelativePath);

    for (const areaPrefix of collectMeaningfulAreaPrefixes(
      normalizedRelativePath,
      packageRootDirectories,
    )) {
      subtreeFileCounts.set(areaPrefix, (subtreeFileCounts.get(areaPrefix) ?? 0) + 1);
    }
  }

  return {
    packageRootDirectories: new Set(packageRootDirectories),
    subtreeFileCounts,
  };
}

export function buildAreaPrefixAllocations(
  areaPrefixes: readonly string[],
  areaMetadata: AreaMetadata,
): readonly { key: string; weight: number }[] {
  if (!areaPrefixes.length) {
    return [];
  }

  const weightedPrefixes = areaPrefixes.map((areaPrefix, index) => {
    const distanceFromLeaf = areaPrefixes.length - index - 1;
    const subtreeFileCount = areaMetadata.subtreeFileCounts.get(areaPrefix) ?? 1;
    const depthWeight = Math.pow(AREA_ANCESTOR_DECAY, distanceFromLeaf);
    const dilutionWeight = Math.pow(Math.max(1, subtreeFileCount), -AREA_SUBTREE_DILUTION_EXPONENT);

    return {
      key: areaPrefix,
      weight: depthWeight * dilutionWeight,
    };
  });
  const totalWeight = weightedPrefixes.reduce((sum, prefix) => sum + prefix.weight, 0);

  if (totalWeight <= 0) {
    return [];
  }

  return weightedPrefixes.map((prefix) => ({
    key: prefix.key,
    weight: prefix.weight / totalWeight,
  }));
}

export function collectMeaningfulAreaPrefixes(
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): readonly string[] {
  const scopeRootDirectory = resolveScopeRootDirectory(filePath, packageRootDirectories);

  if (!scopeRootDirectory) {
    return [];
  }

  const directoriesWithinScope = getDirectoryPrefixesWithinScope(filePath, scopeRootDirectory);

  return [scopeRootDirectory, ...directoriesWithinScope];
}

export function resolveScopeRootDirectory(
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): string | undefined {
  const packageRootDirectory = findNearestPackageRoot(
    getRelativeDirectory(filePath),
    packageRootDirectories,
  );

  if (packageRootDirectory) {
    return packageRootDirectory;
  }

  return getTopLevelScopeRootDirectory(filePath);
}

function getDirectoryPrefixesWithinScope(
  filePath: string,
  scopeRootDirectory: string,
): readonly string[] {
  const fileDirectory = getRelativeDirectory(filePath);

  if (!fileDirectory || fileDirectory === scopeRootDirectory) {
    return [];
  }

  const scopePrefix = scopeRootDirectory ? `${scopeRootDirectory}/` : "";
  const relativeDirectory = fileDirectory.startsWith(scopePrefix)
    ? fileDirectory.slice(scopePrefix.length)
    : fileDirectory;
  const segments = relativeDirectory.split("/").filter(Boolean);
  const directories: string[] = [];
  let currentDirectory = scopeRootDirectory;

  for (const segment of segments) {
    currentDirectory = currentDirectory ? `${currentDirectory}/${segment}` : segment;
    directories.push(currentDirectory);
  }

  return directories;
}

function getRelativeDirectory(filePath: string): string {
  const directory = path.posix.dirname(filePath);

  return directory === "." ? "" : directory;
}

function getTopLevelScopeRootDirectory(filePath: string): string | undefined {
  const segments = filePath.split("/").filter(Boolean);

  return segments.length > 1 ? segments[0] : undefined;
}

function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}
