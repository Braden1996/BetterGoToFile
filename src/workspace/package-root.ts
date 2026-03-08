import * as path from "node:path";

const PACKAGE_MANIFEST_FILENAMES = new Set(["package.json", "project.json"]);

export function collectPackageRootDirectories(relativePaths: readonly string[]): Set<string> {
  const packageRootDirectories = new Set<string>();

  for (const relativePath of relativePaths) {
    if (!isPackageManifestPath(relativePath)) {
      continue;
    }

    packageRootDirectories.add(normalizeRelativeDirectory(path.posix.dirname(relativePath)));
  }

  return packageRootDirectories;
}

export function findNearestPackageRoot(
  directory: string,
  packageRootDirectories: ReadonlySet<string>,
): string | undefined {
  let candidate = directory;

  while (true) {
    if (packageRootDirectories.has(candidate)) {
      return candidate;
    }

    if (!candidate) {
      return undefined;
    }

    candidate = normalizeRelativeDirectory(path.posix.dirname(candidate));
  }
}

export function isPackageManifestPath(relativePath: string): boolean {
  return PACKAGE_MANIFEST_FILENAMES.has(path.posix.basename(relativePath));
}

function normalizeRelativeDirectory(value: string): string {
  return value === "." ? "" : value;
}
