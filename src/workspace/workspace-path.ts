import * as path from "node:path";
import * as vscode from "vscode";

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
