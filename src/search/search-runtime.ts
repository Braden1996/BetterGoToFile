import * as path from "node:path";
import * as vscode from "vscode";
import {
  type BetterGoToFileConfig,
  BetterGoToFileConfigStore,
  isUsingCustomScoring,
} from "../config";
import {
  scoreContributorFile,
  scoreGitSessionOverlay,
  ContributorRelationshipIndex,
  type FileEntry,
  type GitTrackingState,
  GitTrackedIndex,
  normalizePath,
  type WorkspaceContributorRelationshipSnapshot,
  type WorkspaceFileIndexStatus,
  toRelativeWorkspacePath,
  WorkspaceFileIndex,
} from "../workspace";
import { FrecencyStore } from "./frecency-store";
import type { FileSearchRankingContext } from "./file-search";

export interface SearchRuntimeStatus {
  readonly index: WorkspaceFileIndexStatus;
  readonly openPathCount: number;
  readonly scoringPreset: BetterGoToFileConfig["scoring"]["preset"];
  readonly usingCustomScoring: boolean;
  readonly gitignoredVisibility: BetterGoToFileConfig["gitignored"]["visibility"];
  readonly contributorRelationships: {
    readonly loadedWorkspaceFolderCount: number;
    readonly primarySnapshot?: WorkspaceContributorRelationshipSnapshot;
  };
}

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
    const workspaceIndexPersistencePath = context.storageUri
      ? path.join(context.storageUri.fsPath, "workspace-index.json")
      : undefined;

    this.index = new WorkspaceFileIndex(this.config.workspaceIndex, {
      persistenceFilePath: workspaceIndexPersistencePath,
      log,
    });
    this.frecencyStore = new FrecencyStore(frecencyPath, this.config.frecency);
    this.gitTrackedIndex = new GitTrackedIndex(this.config.git, log);
    this.contributorRelationshipIndex = new ContributorRelationshipIndex(
      context.storageUri
        ? path.join(context.storageUri.fsPath, "contributor-relationships")
        : undefined,
      log,
    );

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
      this.contributorRelationshipIndex.onDidChange(() => {
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
    await Promise.all([this.index.ready(), this.frecencyStore.ready()]);
  }

  getConfig(): BetterGoToFileConfig {
    return this.config;
  }

  getEntries(): readonly FileEntry[] {
    return this.index.getEntries();
  }

  getStatus(): SearchRuntimeStatus {
    const contributorRelationshipSnapshots = this.contributorRelationshipIndex.getLoadedSnapshots();

    return {
      index: this.index.getStatus(),
      openPathCount: collectOpenPaths().size,
      scoringPreset: this.config.scoring.preset,
      usingCustomScoring: isUsingCustomScoring(this.config),
      gitignoredVisibility: this.config.gitignored.visibility,
      contributorRelationships: {
        loadedWorkspaceFolderCount: contributorRelationshipSnapshots.length,
        primarySnapshot: getPrimaryContributorRelationshipSnapshot(
          contributorRelationshipSnapshots,
        ),
      },
    };
  }

  buildRankingContext(): FileSearchRankingContext {
    const now = Date.now();
    const activePath = getActivePath();
    const frecencyScores = new Map<string, number>();
    const gitPriors = new Map<string, number>();
    const gitTrackingStates = new Map<string, GitTrackingState>();

    return {
      activePath,
      activePackageRoot: activePath ? this.index.getEntry(activePath)?.packageRoot : undefined,
      openPaths: collectOpenPaths(),
      getFrecencyScore: (relativePath) => {
        const cachedScore = frecencyScores.get(relativePath);

        if (cachedScore !== undefined) {
          return cachedScore;
        }

        const score = this.frecencyStore.getCurrentScore(relativePath, now);

        frecencyScores.set(relativePath, score);
        return score;
      },
      getGitPrior: (entry) => {
        const cachedPrior = gitPriors.get(entry.relativePath);

        if (cachedPrior !== undefined) {
          return cachedPrior;
        }

        const prior = this.getGitPrior(entry);

        gitPriors.set(entry.relativePath, prior);
        return prior;
      },
      getGitTrackingState: (entry) => {
        const cachedState = gitTrackingStates.get(entry.relativePath);

        if (cachedState !== undefined) {
          return cachedState;
        }

        const gitTrackingState = this.gitTrackedIndex.getTrackingState(entry.uri);

        gitTrackingStates.set(entry.relativePath, gitTrackingState);
        return gitTrackingState;
      },
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

  async refreshIndex(): Promise<void> {
    await this.index.refreshNow();
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

  private getGitPrior(entry: FileEntry): number {
    const workspaceFolderPath = entry.workspaceFolderPath;
    const contributorState = workspaceFolderPath
      ? this.contributorRelationshipIndex.getSearchState(workspaceFolderPath)
      : undefined;
    const sessionState = this.gitTrackedIndex.getSessionState(entry.uri);
    const repoRootPath = contributorState?.repoRootPath ?? sessionState?.repoRootPath;

    if (!repoRootPath) {
      return 0;
    }

    const repoRelativePath = normalizePath(path.relative(repoRootPath, entry.uri.fsPath));

    if (!repoRelativePath || repoRelativePath.startsWith("..")) {
      return 0;
    }

    const contributorPrior = contributorState
      ? scoreContributorFile(
          contributorState.profile,
          repoRelativePath,
          contributorState.packageRootDirectories,
        ).total
      : 0;
    const sessionPrior = sessionState
      ? scoreGitSessionOverlay(
          sessionState.sessionOverlay,
          repoRelativePath,
          sessionState.packageRootDirectories,
        )
      : 0;

    return contributorPrior + 1.6 * sessionPrior;
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

function getPrimaryContributorRelationshipSnapshot(
  snapshots: readonly WorkspaceContributorRelationshipSnapshot[],
): WorkspaceContributorRelationshipSnapshot | undefined {
  const activeWorkspaceFolderPath = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
    : undefined;

  if (activeWorkspaceFolderPath) {
    const activeSnapshot = snapshots.find(
      (snapshot) => snapshot.workspaceFolderPath === activeWorkspaceFolderPath,
    );

    if (activeSnapshot) {
      return activeSnapshot;
    }
  }

  return snapshots.find((snapshot) => snapshot.status === "ready") ?? snapshots[0];
}
