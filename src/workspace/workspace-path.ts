import * as vscode from "vscode";
import { normalizeDirectory, normalizePath } from "./path-normalization";

export function toRelativeWorkspacePath(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }

  return normalizePath(vscode.workspace.asRelativePath(uri, false));
}

export { normalizeDirectory, normalizePath };
