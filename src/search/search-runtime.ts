import * as path from "node:path";
import * as vscode from "vscode";
import { type BetterGoToFileConfig, BetterGoToFileConfigStore } from "../config";
import {
  ContributorRelationshipIndex,
  type FileEntry,
  GitTrackedIndex,
  type WorkspaceContributorRelationshipSnapshot,
  toRelativeWorkspacePath,
  WorkspaceFileIndex,
} from "../workspace";
import { FrecencyStore } from "./frecency-store";
import type { FileSearchRankingContext } from "./file-search";

export class SearchRuntime implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly index: WorkspaceFileIndex;
  private readonly frecencyStore: FrecencyStore;
  private readonly gitTrackedIndex: GitTrackedIndex;
  private readonly contributorRelationshipIndex: ContributorRelationshipIndex;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentVisits = new Map<string, number>();
  private config: BetterGoToFileConfig;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: BetterGoToFileConfigStore,
    private readonly log?: (message: string) => void,
  ) {
    this.config = configStore.get();

    const frecencyPath = context.storageUri
      ? path.join(context.storageUri.fsPath, "frecency.json")
      : undefined;

    this.index = new WorkspaceFileIndex(this.config.workspaceIndex, log);
    this.frecencyStore = new FrecencyStore(frecencyPath, this.config.frecency);
    this.gitTrackedIndex = new GitTrackedIndex(this.config.git, log);
    this.contributorRelationshipIndex = new ContributorRelationshipIndex(log);

    this.disposables.push(
      this.emitter,
      this.configStore,
      this.index,
      { dispose: () => this.frecencyStore.dispose() },
      this.gitTrackedIndex,
      this.contributorRelationshipIndex,
      this.index.onDidChange(() => {
        this.emitter.fire();
      }),
      this.gitTrackedIndex.onDidChange(() => {
        this.emitter.fire();
      }),
      this.configStore.onDidChange(({ current }) => {
        this.applyConfig(current);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.scheduleImplicitOpen(editor);
        this.emitter.fire();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.emitter.fire();
      }),
    );

    this.scheduleImplicitOpen(vscode.window.activeTextEditor);
  }

  async ready(): Promise<void> {
    await Promise.all([
      this.index.ready(),
      this.frecencyStore.ready(),
      this.gitTrackedIndex.ready(),
    ]);
  }

  getConfig(): BetterGoToFileConfig {
    return this.config;
  }

  getEntries(): readonly FileEntry[] {
    return this.index.getEntries();
  }

  buildRankingContext(): FileSearchRankingContext {
    const now = Date.now();

    return {
      activePath: getActivePath(),
      openPaths: collectOpenPaths(),
      getFrecencyScore: (relativePath) => this.frecencyStore.getCurrentScore(relativePath, now),
      getGitTrackingState: (entry) => this.gitTrackedIndex.getTrackingState(entry.uri),
    };
  }

  recordExplicitOpen(relativePath: string): void {
    const now = Date.now();

    this.rememberVisit(relativePath, now);
    this.frecencyStore.recordOpen(relativePath, {
      now,
      weight: this.config.visits.explicitOpenWeight,
    });
  }

  async inspectContributorRelationships(): Promise<
    readonly WorkspaceContributorRelationshipSnapshot[]
  > {
    return this.contributorRelationshipIndex.inspectWorkspaceFolders();
  }

  dispose(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private applyConfig(config: BetterGoToFileConfig): void {
    this.config = config;
    this.index.updateConfig(config.workspaceIndex);
    this.frecencyStore.updateOptions(config.frecency);
    this.gitTrackedIndex.updateConfig(config.git);
    this.scheduleImplicitOpen(vscode.window.activeTextEditor);
    this.emitter.fire();
  }

  private scheduleImplicitOpen(editor: vscode.TextEditor | undefined): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    const relativePath = editor ? toRelativeWorkspacePath(editor.document.uri) : undefined;

    if (!relativePath) {
      return;
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.recordImplicitOpen(relativePath);
    }, this.config.visits.editorDwellMs);
  }

  private recordImplicitOpen(relativePath: string): void {
    const now = Date.now();

    if (this.isDuplicateVisit(relativePath, now)) {
      return;
    }

    this.rememberVisit(relativePath, now);
    this.frecencyStore.recordOpen(relativePath, {
      now,
      weight: this.config.visits.implicitOpenWeight,
    });
  }

  private isDuplicateVisit(relativePath: string, now: number): boolean {
    const lastVisit = this.recentVisits.get(relativePath);

    return (
      typeof lastVisit === "number" && now - lastVisit < this.config.visits.duplicateVisitWindowMs
    );
  }

  private rememberVisit(relativePath: string, now: number): void {
    this.recentVisits.set(relativePath, now);

    for (const [pathKey, lastVisit] of this.recentVisits.entries()) {
      if (now - lastVisit > this.config.visits.duplicateVisitWindowMs) {
        this.recentVisits.delete(pathKey);
      }
    }
  }
}

function getActivePath(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;

  return activeEditor ? toRelativeWorkspacePath(activeEditor.document.uri) : undefined;
}

function collectOpenPaths(): Set<string> {
  const paths = new Set<string>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;

      if (input instanceof vscode.TabInputText) {
        maybeAddPath(paths, input.uri);
      } else if (input instanceof vscode.TabInputTextDiff) {
        maybeAddPath(paths, input.original);
        maybeAddPath(paths, input.modified);
      } else if (input instanceof vscode.TabInputCustom) {
        maybeAddPath(paths, input.uri);
      } else if (input instanceof vscode.TabInputNotebook) {
        maybeAddPath(paths, input.uri);
      } else if (input instanceof vscode.TabInputNotebookDiff) {
        maybeAddPath(paths, input.original);
        maybeAddPath(paths, input.modified);
      }
    }
  }

  return paths;
}

function maybeAddPath(paths: Set<string>, uri: vscode.Uri): void {
  const relativePath = toRelativeWorkspacePath(uri);

  if (relativePath) {
    paths.add(relativePath);
  }
}
