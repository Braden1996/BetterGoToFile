import * as path from "node:path";
import * as vscode from "vscode";

export interface FileEntry {
  readonly uri: vscode.Uri;
  readonly basename: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly workspaceFolderName?: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

export function toFileEntry(uri: vscode.Uri, isMultiRoot: boolean): FileEntry {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));
  const basename = path.basename(relativePath);
  const directory = normalizeDirectory(path.dirname(relativePath));

  return {
    uri,
    basename,
    relativePath,
    directory,
    workspaceFolderName: isMultiRoot ? workspaceFolder?.name : undefined,
    searchBasename: basename.toLowerCase(),
    searchPath: relativePath.toLowerCase(),
  };
}

export function toRelativeWorkspacePath(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }

  return normalizePath(vscode.workspace.asRelativePath(uri, false));
}

export function normalizeDirectory(value: string): string {
  return value === "." ? "" : normalizePath(value);
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}

export function defaultSort(left: FileEntry, right: FileEntry): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}
