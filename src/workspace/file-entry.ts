import * as path from "node:path";
import * as vscode from "vscode";
import { findNearestPackageRoot } from "./package-root";
import { normalizeDirectory, normalizePath } from "./workspace-path";

export interface FileEntry {
  readonly uri: vscode.Uri;
  readonly basename: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly packageRoot?: string;
  readonly workspaceFolderPath?: string;
  readonly workspaceFolderName?: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

const EMPTY_PACKAGE_ROOT_DIRECTORIES = new Set<string>();

export function toFileEntry(
  uri: vscode.Uri,
  isMultiRoot: boolean,
  packageRootDirectories: ReadonlySet<string> = EMPTY_PACKAGE_ROOT_DIRECTORIES,
): FileEntry {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));
  const basename = path.basename(relativePath);
  const directory = normalizeDirectory(path.dirname(relativePath));
  const packageRoot = findNearestPackageRoot(directory, packageRootDirectories);

  return {
    uri,
    basename,
    relativePath,
    directory,
    packageRoot,
    workspaceFolderPath: workspaceFolder?.uri.fsPath,
    workspaceFolderName: isMultiRoot ? workspaceFolder?.name : undefined,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  };
}

export function defaultSort(left: FileEntry, right: FileEntry): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}
