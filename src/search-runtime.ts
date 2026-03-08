import * as path from "node:path";
import * as vscode from "vscode";
import { toRelativeWorkspacePath, type FileEntry } from "./file-entry";
import { FrecencyStore } from "./frecency-store";
import { GitTrackedIndex } from "./git-tracked-index";
import type { FileSearchRankingContext } from "./file-search";
import { WorkspaceFileIndex } from "./workspace-index";

const IMPLICIT_OPEN_WEIGHT = 1;
const EXPLICIT_OPEN_WEIGHT = 2;
const EDITOR_DWELL_MS = 900;
const DUPLICATE_VISIT_WINDOW_MS = 15_000;

export class SearchRuntime implements vscode.Disposable {
  private readonly index: WorkspaceFileIndex;
  private readonly frecencyStore: FrecencyStore;
  private readonly gitTrackedIndex: GitTrackedIndex;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentVisits = new Map<string, number>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log?: (message: string) => void,
  ) {
    const frecencyPath = context.storageUri
      ? path.join(context.storageUri.fsPath, "frecency.json")
      : undefined;

    this.index = new WorkspaceFileIndex(log);
    this.frecencyStore = new FrecencyStore(frecencyPath);
    this.gitTrackedIndex = new GitTrackedIndex(log);

    this.disposables.push(
      this.index,
      { dispose: () => this.frecencyStore.dispose() },
      this.gitTrackedIndex,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.scheduleImplicitOpen(editor);
      }),
    );

    this.scheduleImplicitOpen(vscode.window.activeTextEditor);
  }

  async ready(): Promise<void> {
    await Promise.all([this.index.ready(), this.frecencyStore.ready()]);
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
    this.frecencyStore.recordOpen(relativePath, { now, weight: EXPLICIT_OPEN_WEIGHT });
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
    }, EDITOR_DWELL_MS);
  }

  private recordImplicitOpen(relativePath: string): void {
    const now = Date.now();

    if (this.isDuplicateVisit(relativePath, now)) {
      return;
    }

    this.rememberVisit(relativePath, now);
    this.frecencyStore.recordOpen(relativePath, { now, weight: IMPLICIT_OPEN_WEIGHT });
  }

  private isDuplicateVisit(relativePath: string, now: number): boolean {
    const lastVisit = this.recentVisits.get(relativePath);

    return typeof lastVisit === "number" && now - lastVisit < DUPLICATE_VISIT_WINDOW_MS;
  }

  private rememberVisit(relativePath: string, now: number): void {
    this.recentVisits.set(relativePath, now);

    for (const [pathKey, lastVisit] of this.recentVisits.entries()) {
      if (now - lastVisit > DUPLICATE_VISIT_WINDOW_MS) {
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
