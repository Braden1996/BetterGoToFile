import * as path from "node:path";
import * as vscode from "vscode";
import { createWorkspacePathIdentity, normalizeDirectory } from "./workspace-path";

export interface FileEntry {
  readonly uri: vscode.Uri;
  readonly basename: string;
  readonly relativePath: string;
  readonly identityPath: string;
  readonly directory: string;
  readonly packageRoot?: string;
  readonly packageRootIdentity?: string;
  readonly workspaceFolderPath?: string;
  readonly workspaceFolderName?: string;
  readonly searchBasename: string;
  readonly searchPath: string;
}

interface CreateFileEntryOptions {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly packageRoot?: string;
  readonly workspaceFolderPath?: string;
  readonly workspaceFolderName?: string;
  readonly isMultiRoot?: boolean;
}

export function createFileEntry(options: CreateFileEntryOptions): FileEntry {
  const basename = path.posix.basename(options.relativePath);
  const directory = normalizeDirectory(path.posix.dirname(options.relativePath));
  const identityPath = createWorkspacePathIdentity(
    options.relativePath,
    options.workspaceFolderPath,
    options.isMultiRoot ?? false,
  );
  const packageRootIdentity =
    options.packageRoot !== undefined
      ? createWorkspacePathIdentity(
          options.packageRoot,
          options.workspaceFolderPath,
          options.isMultiRoot ?? false,
        )
      : undefined;

  return {
    uri: options.uri,
    basename,
    relativePath: options.relativePath,
    identityPath,
    directory,
    packageRoot: options.packageRoot,
    packageRootIdentity,
    workspaceFolderPath: options.workspaceFolderPath,
    workspaceFolderName: options.workspaceFolderName,
    searchBasename: basename.toLowerCase(),
    searchPath: options.relativePath.toLowerCase(),
  };
}

export function defaultSort(left: FileEntry, right: FileEntry): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.identityPath.localeCompare(right.identityPath)
  );
}
