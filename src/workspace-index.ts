import * as vscode from "vscode";
import { defaultSort, type FileEntry, toFileEntry, toRelativeWorkspacePath } from "./file-entry";

const FILE_GLOB = "**/*";
const EXCLUDE_GLOB = "**/{.git,node_modules,dist,out,.next,.turbo,coverage}/**";
const MAX_FILE_COUNT = 50000;
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".next",
  ".turbo",
  "coverage",
]);

export class WorkspaceFileIndex implements vscode.Disposable {
  private readonly entriesByPath = new Map<string, FileEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshPromise = Promise.resolve();
  private sortedEntries: readonly FileEntry[] = [];

  constructor(private readonly log?: (message: string) => void) {
    this.scheduleRefresh();

    const watcher = vscode.workspace.createFileSystemWatcher(FILE_GLOB, false, true, false);

    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => {
        this.upsert(uri);
      }),
      watcher.onDidDelete((uri) => {
        this.remove(uri);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRefresh();
      }),
    );
  }

  async ready(): Promise<void> {
    await this.refreshPromise;
  }

  getEntries(): readonly FileEntry[] {
    return this.sortedEntries;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(): void {
    this.refreshPromise = this.refreshPromise.then(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders?.length) {
      this.entriesByPath.clear();
      this.sortedEntries = [];
      return;
    }

    const isMultiRoot = folders.length > 1;
    const files = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, MAX_FILE_COUNT);
    const entries = files.map((uri) => toFileEntry(uri, isMultiRoot)).sort(defaultSort);

    this.entriesByPath.clear();

    for (const entry of entries) {
      this.entriesByPath.set(entry.relativePath, entry);
    }

    this.sortedEntries = entries;
    this.log?.(`Indexed ${entries.length} workspace files.`);
  }

  private upsert(uri: vscode.Uri): void {
    const relativePath = toRelativeWorkspacePath(uri);

    if (!relativePath || !shouldIndexRelativePath(relativePath)) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    const isMultiRoot = Boolean(folders && folders.length > 1);
    const entry = toFileEntry(uri, isMultiRoot);

    this.entriesByPath.set(entry.relativePath, entry);
    this.rebuildSortedEntries();
  }

  private remove(uri: vscode.Uri): void {
    const relativePath = toRelativeWorkspacePath(uri);

    if (!relativePath) {
      return;
    }

    if (!this.entriesByPath.delete(relativePath)) {
      return;
    }

    this.rebuildSortedEntries();
  }

  private rebuildSortedEntries(): void {
    this.sortedEntries = [...this.entriesByPath.values()].sort(defaultSort);
  }
}

function shouldIndexRelativePath(relativePath: string): boolean {
  return relativePath.split("/").every((segment) => !EXCLUDED_SEGMENTS.has(segment));
}
