import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeDirectory } from "./workspace-path";

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

interface CreateFileEntryOptions {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly packageRoot?: string;
  readonly workspaceFolderPath?: string;
  readonly workspaceFolderName?: string;
}

export function createFileEntry(options: CreateFileEntryOptions): FileEntry {
  const basename = path.posix.basename(options.relativePath);
  const directory = normalizeDirectory(path.posix.dirname(options.relativePath));

  return {
    uri: options.uri,
    basename,
    relativePath: options.relativePath,
    directory,
    packageRoot: options.packageRoot,
    workspaceFolderPath: options.workspaceFolderPath,
    workspaceFolderName: options.workspaceFolderName,
    searchBasename: basename.toLowerCase(),
    searchPath: options.relativePath.toLowerCase(),
  };
}

export function defaultSort(left: FileEntry, right: FileEntry): number {
  return (
    left.basename.localeCompare(right.basename) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}
