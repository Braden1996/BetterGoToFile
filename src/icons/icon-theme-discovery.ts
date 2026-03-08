import * as path from "node:path";
import * as vscode from "vscode";
import { isRecord, normalizeOptionalString } from "./icon-theme-parser";
import type { IconThemeContribution } from "./types";

export function findIconThemeContribution(
  themeId: string,
): { extension: vscode.Extension<unknown>; iconTheme: IconThemeContribution } | undefined {
  for (const extension of vscode.extensions.all) {
    for (const iconTheme of getIconThemeContributions(extension.packageJSON)) {
      if (iconTheme.id === themeId) {
        return { extension, iconTheme };
      }
    }
  }

  return undefined;
}

export async function resolveIconThemeUri(
  extension: vscode.Extension<unknown>,
  relativePath: string,
  log?: (message: string) => void,
): Promise<vscode.Uri> {
  const candidateRoots = await getExtensionRootCandidates(extension);

  for (const root of candidateRoots) {
    const candidateThemeUri = resolveRelativeUriFromDirectory(root, relativePath);

    if (await fileExists(candidateThemeUri)) {
      if (root.toString() !== extension.extensionUri.toString()) {
        log?.(`Recovered extension root for ${extension.id} at ${root.toString(true)}`);
      }

      return candidateThemeUri;
    }
  }

  return resolveRelativeUriFromDirectory(extension.extensionUri, relativePath);
}

function getIconThemeContributions(packageJson: unknown): readonly IconThemeContribution[] {
  if (!isRecord(packageJson)) {
    return [];
  }

  const contributes = packageJson["contributes"];

  if (!isRecord(contributes)) {
    return [];
  }

  const iconThemes = contributes["iconThemes"];

  if (!Array.isArray(iconThemes)) {
    return [];
  }

  return iconThemes.flatMap((iconTheme): IconThemeContribution[] => {
    if (!isRecord(iconTheme)) {
      return [];
    }

    const id = iconTheme["id"];
    const iconThemePath = iconTheme["path"];

    if (typeof id !== "string" || typeof iconThemePath !== "string") {
      return [];
    }

    return [{ id, path: iconThemePath }];
  });
}

async function getExtensionRootCandidates(
  extension: vscode.Extension<unknown>,
): Promise<vscode.Uri[]> {
  const candidates = new Map<string, vscode.Uri>();
  const pushCandidate = (candidate: vscode.Uri | undefined): void => {
    if (!candidate) {
      return;
    }

    candidates.set(candidate.toString(), candidate);
  };

  pushCandidate(extension.extensionUri);

  if (extension.extensionUri.scheme === "file") {
    pushCandidate(vscode.Uri.file(extension.extensionPath));

    const currentRootMatches = await findMatchingExtensionDirectories(
      extension.extensionUri,
      extension,
    );

    for (const match of currentRootMatches) {
      pushCandidate(match);
    }

    const parentDirectory = path.dirname(extension.extensionUri.fsPath);

    if (parentDirectory && parentDirectory !== extension.extensionUri.fsPath) {
      const siblingMatches = await findMatchingExtensionDirectories(
        vscode.Uri.file(parentDirectory),
        extension,
      );

      for (const match of siblingMatches) {
        pushCandidate(match);
      }
    }
  }

  return [...candidates.values()];
}

async function findMatchingExtensionDirectories(
  parentDirectory: vscode.Uri,
  extension: vscode.Extension<unknown>,
): Promise<vscode.Uri[]> {
  if (parentDirectory.scheme !== "file") {
    return [];
  }

  try {
    const directoryEntries = await vscode.workspace.fs.readDirectory(parentDirectory);
    const prefixes = buildExtensionDirectoryPrefixes(extension);
    const matches: vscode.Uri[] = [];

    for (const [name, fileType] of directoryEntries) {
      if (fileType !== vscode.FileType.Directory) {
        continue;
      }

      const normalizedName = name.toLowerCase();

      if (
        prefixes.some(
          (prefix) => normalizedName === prefix || normalizedName.startsWith(`${prefix}-`),
        )
      ) {
        matches.push(vscode.Uri.joinPath(parentDirectory, name));
      }
    }

    matches.sort(
      (left, right) =>
        scoreExtensionDirectory(right, extension) - scoreExtensionDirectory(left, extension),
    );

    return matches;
  } catch {
    return [];
  }
}

function buildExtensionDirectoryPrefixes(extension: vscode.Extension<unknown>): string[] {
  const prefixes = new Set<string>();

  if (extension.id) {
    prefixes.add(extension.id.toLowerCase());
  }

  const packageJson = extension.packageJSON;

  if (isRecord(packageJson)) {
    const publisher = normalizeOptionalString(packageJson["publisher"])?.toLowerCase();
    const name = normalizeOptionalString(packageJson["name"])?.toLowerCase();
    const version = normalizeOptionalString(packageJson["version"])?.toLowerCase();

    if (publisher && name) {
      prefixes.add(`${publisher}.${name}`);

      if (version) {
        prefixes.add(`${publisher}.${name}-${version}`);
      }
    }
  }

  return [...prefixes];
}

function scoreExtensionDirectory(
  directory: vscode.Uri,
  extension: vscode.Extension<unknown>,
): number {
  if (directory.scheme !== "file") {
    return 0;
  }

  const directoryName = path.basename(directory.fsPath).toLowerCase();
  let score = 0;

  if (directoryName === extension.id.toLowerCase()) {
    score += 4;
  }

  if (directoryName.startsWith(`${extension.id.toLowerCase()}-`)) {
    score += 3;
  }

  const packageJson = extension.packageJSON;

  if (isRecord(packageJson)) {
    const publisher = normalizeOptionalString(packageJson["publisher"])?.toLowerCase();
    const name = normalizeOptionalString(packageJson["name"])?.toLowerCase();
    const version = normalizeOptionalString(packageJson["version"])?.toLowerCase();

    if (publisher && name) {
      const packagePrefix = `${publisher}.${name}`;

      if (directoryName === packagePrefix) {
        score += 2;
      }

      if (directoryName.startsWith(`${packagePrefix}-`)) {
        score += 2;
      }

      if (version && directoryName.includes(`-${version}`)) {
        score += 2;
      }
    }
  }

  return score;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function resolveRelativeUriFromDirectory(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
  if (baseUri.scheme !== "file") {
    return vscode.Uri.joinPath(baseUri, relativePath);
  }

  return vscode.Uri.file(path.resolve(baseUri.fsPath, relativePath));
}
