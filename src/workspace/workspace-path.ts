import * as vscode from "vscode";
import { normalizeDirectory, normalizePath } from "./path-normalization";

export function toRelativeWorkspacePath(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }

  return normalizePath(vscode.workspace.asRelativePath(uri, false));
}

export function createWorkspacePathIdentity(
  relativePath: string,
  workspaceFolderPath: string | undefined,
  isMultiRoot: boolean,
): string {
  if (!isMultiRoot || !workspaceFolderPath) {
    return relativePath;
  }

  return `${normalizePath(workspaceFolderPath)}::${relativePath}`;
}

export function toWorkspacePathIdentity(uri: vscode.Uri): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

  if (!workspaceFolder) {
    return undefined;
  }

  const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));

  return createWorkspacePathIdentity(
    relativePath,
    workspaceFolder.uri.fsPath,
    (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
  );
}

export { normalizeDirectory, normalizePath };
