import * as vscode from "vscode";
import type { WorkspaceIndexConfig } from "../config/schema";
import { defaultSort, type FileEntry, toFileEntry } from "./file-entry";
import { collectPackageRootDirectories, isPackageManifestPath } from "./package-root";
import { toRelativeWorkspacePath } from "./workspace-path";

export class WorkspaceFileIndex implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly entriesByPath = new Map<string, FileEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcherDisposable: vscode.Disposable | undefined;
  private config: WorkspaceIndexConfig;
  private packageRootDirectories = new Set<string>();
  private refreshPromise = Promise.resolve();
  private sortedEntries: readonly FileEntry[] = [];

  readonly onDidChange = this.emitter.event;

  constructor(
    config: WorkspaceIndexConfig,
    private readonly log?: (message: string) => void,
  ) {
    this.config = config;
    this.watcherDisposable = this.createWatcher();
    this.scheduleRefresh();

    this.disposables.push(
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

  updateConfig(config: WorkspaceIndexConfig): void {
    const shouldRecreateWatcher = config.fileGlob !== this.config.fileGlob;

    this.config = config;

    if (shouldRecreateWatcher) {
      this.watcherDisposable?.dispose();
      this.watcherDisposable = this.createWatcher();
    }

    this.scheduleRefresh();
  }

  dispose(): void {
    this.watcherDisposable?.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.emitter.dispose();
  }

  private scheduleRefresh(): void {
    this.refreshPromise = this.refreshPromise.then(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders?.length) {
      this.entriesByPath.clear();
      this.sortedEntries = [];
      this.emitter.fire();
      return;
    }

    const isMultiRoot = folders.length > 1;
    const files = await vscode.workspace.findFiles(
      this.config.fileGlob,
      toExcludeGlob(this.config.excludedDirectories),
      this.config.maxFileCount,
    );
    this.packageRootDirectories = collectPackageRootDirectories(
      files.map((uri) => toRelativeWorkspacePath(uri)).filter(isDefined),
    );
    const entries = files
      .map((uri) => toFileEntry(uri, isMultiRoot, this.packageRootDirectories))
      .sort(defaultSort);

    this.entriesByPath.clear();

    for (const entry of entries) {
      this.entriesByPath.set(entry.relativePath, entry);
    }

    this.sortedEntries = entries;
    this.log?.(`Indexed ${entries.length} workspace files.`);
    this.emitter.fire();
  }

  private upsert(uri: vscode.Uri): void {
    const relativePath = toRelativeWorkspacePath(uri);

    if (!relativePath || !shouldIndexRelativePath(relativePath, this.config.excludedDirectories)) {
      return;
    }

    if (isPackageManifestPath(relativePath)) {
      this.scheduleRefresh();
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    const isMultiRoot = Boolean(folders && folders.length > 1);
    const entry = toFileEntry(uri, isMultiRoot, this.packageRootDirectories);

    this.entriesByPath.set(entry.relativePath, entry);
    this.rebuildSortedEntries();
  }

  private remove(uri: vscode.Uri): void {
    const relativePath = toRelativeWorkspacePath(uri);

    if (!relativePath) {
      return;
    }

    if (isPackageManifestPath(relativePath)) {
      this.scheduleRefresh();
      return;
    }

    if (!this.entriesByPath.delete(relativePath)) {
      return;
    }

    this.rebuildSortedEntries();
  }

  private rebuildSortedEntries(): void {
    this.sortedEntries = [...this.entriesByPath.values()].sort(defaultSort);
    this.emitter.fire();
  }

  private createWatcher(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(
      this.config.fileGlob,
      false,
      true,
      false,
    );

    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate((uri) => {
        this.upsert(uri);
      }),
      watcher.onDidDelete((uri) => {
        this.remove(uri);
      }),
    );
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function shouldIndexRelativePath(
  relativePath: string,
  excludedDirectories: readonly string[],
): boolean {
  const excludedSegments = new Set(excludedDirectories);

  return relativePath.split("/").every((segment) => !excludedSegments.has(segment));
}

function toExcludeGlob(excludedDirectories: readonly string[]): string | undefined {
  if (!excludedDirectories.length) {
    return undefined;
  }

  return `**/{${excludedDirectories.join(",")}}/**`;
}
