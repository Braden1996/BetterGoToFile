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
  toWorkspacePathIdentity,
  WorkspaceFileIndex,
} from "../workspace";
import { FrecencyStore } from "./frecency-store";
import type { FileSearchRankingContext } from "./file-search";

export interface SearchRuntimeStatus {
  readonly index: WorkspaceFileIndexStatus;
  readonly openPathCount: number;
  readonly scoringPreset: BetterGoToFileConfig["scoring"]["preset"];
  readonly usingCustomScoring: boolean;
  readonly gitignoredVisibility: BetterGoToFileConfig["gitignored"];
  readonly pickerReadiness: SearchRuntimePickerReadinessStatus;
  readonly contributorRelationships: {
    readonly loadedWorkspaceFolderCount: number;
    readonly primarySnapshot?: WorkspaceContributorRelationshipSnapshot;
  };
}

export interface SearchRuntimePickerReadinessStatus {
  readonly isReady: boolean;
  readonly isWorkspaceIndexReady: boolean;
  readonly isFrecencyReady: boolean;
  readonly isGitTrackingReady: boolean;
  readonly isContributorRelationshipsReady: boolean;
}

export class SearchRuntime implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly index: WorkspaceFileIndex;
  private readonly frecencyStore: FrecencyStore;
  private readonly gitTrackedIndex: GitTrackedIndex;
  private readonly contributorRelationshipIndex: ContributorRelationshipIndex;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentVisits = new Map<string, number>();
  private readonly cachedGitPriors = new Map<string, number>();
  private readonly cachedGitTrackingStates = new Map<string, GitTrackingState>();
  private config: BetterGoToFileConfig;
  private openIdentityPaths = collectOpenIdentityPaths();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pickerReadiness = {
    isWorkspaceIndexReady: false,
    isFrecencyReady: false,
    isGitTrackingReady: false,
    isContributorRelationshipsReady: false,
  };
  private readonly pickerReadyPromise: Promise<void>;

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
    const gitTrackedIndexPersistencePath = context.storageUri
      ? path.join(context.storageUri.fsPath, "git-tracked-index.json")
      : undefined;

    this.index = new WorkspaceFileIndex(this.config.workspaceIndex, {
      persistenceFilePath: workspaceIndexPersistencePath,
      log,
    });
    this.frecencyStore = new FrecencyStore(frecencyPath, {
      ...this.config.frecency,
      log,
    });
    this.gitTrackedIndex = new GitTrackedIndex(this.config.git, {
      persistenceFilePath: gitTrackedIndexPersistencePath,
      log,
    });
    this.contributorRelationshipIndex = new ContributorRelationshipIndex(
      context.storageUri
        ? path.join(context.storageUri.fsPath, "contributor-relationships")
        : undefined,
      log,
    );
    const indexReadyPromise = this.trackPickerDependencyReady(
      "isWorkspaceIndexReady",
      this.index.ready(),
    );
    const frecencyReadyPromise = this.trackPickerDependencyReady(
      "isFrecencyReady",
      this.frecencyStore.ready(),
    );
    const gitTrackingReadyPromise = this.trackPickerDependencyReady(
      "isGitTrackingReady",
      this.gitTrackedIndex.ready(),
    );
    const contributorRelationshipsReadyPromise = this.trackPickerDependencyReady(
      "isContributorRelationshipsReady",
      this.contributorRelationshipIndex.ready(),
    );
    this.pickerReadyPromise = Promise.all([
      indexReadyPromise,
      frecencyReadyPromise,
      gitTrackingReadyPromise,
      contributorRelationshipsReadyPromise,
    ]).then(() => undefined);
    this.disposables.push(
      this.emitter,
      this.configStore,
      this.index,
      { dispose: () => this.frecencyStore.dispose() },
      this.gitTrackedIndex,
      this.contributorRelationshipIndex,
      this.index.onDidChange(() => {
        this.cachedGitPriors.clear();
        this.cachedGitTrackingStates.clear();
        this.emitter.fire();
      }),
      this.gitTrackedIndex.onDidChange(() => {
        this.cachedGitPriors.clear();
        this.cachedGitTrackingStates.clear();
        this.emitter.fire();
      }),
      this.contributorRelationshipIndex.onDidChange(() => {
        this.cachedGitPriors.clear();
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
        this.openIdentityPaths = collectOpenIdentityPaths();
        this.emitter.fire();
      }),
    );

    this.scheduleImplicitOpen(vscode.window.activeTextEditor);
  }

  async ready(): Promise<void> {
    await this.pickerReadyPromise;
  }

  isReadyForPicker(): boolean {
    return Object.values(this.pickerReadiness).every(Boolean);
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
      openPathCount: this.openIdentityPaths.size,
      scoringPreset: this.config.scoring.preset,
      usingCustomScoring: isUsingCustomScoring(this.config),
      gitignoredVisibility: this.config.gitignored,
      pickerReadiness: {
        isReady: this.isReadyForPicker(),
        ...this.pickerReadiness,
      },
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
    const activeIdentityPath = getActiveIdentityPath();
    const activeEntry = activeIdentityPath ? this.index.getEntry(activeIdentityPath) : undefined;
    const activeWorkspaceFolderPath = getActiveWorkspaceFolderPath();
    const frecencyScores = new Map<string, number>();

    return {
      activePath: activeEntry?.relativePath ?? activePath,
      activeIdentityPath,
      activePackageRoot: activeEntry?.packageRoot,
      activePackageRootIdentity: activeEntry?.packageRootIdentity,
      activeWorkspaceFolderPath,
      openIdentityPaths: this.openIdentityPaths,
      getFrecencyScore: (identityPath) => {
        const cachedScore = frecencyScores.get(identityPath);

        if (cachedScore !== undefined) {
          return cachedScore;
        }

        const score = this.frecencyStore.getCurrentScore(identityPath, now);

        frecencyScores.set(identityPath, score);
        return score;
      },
      getGitPrior: (entry) => {
        const cachedPrior = this.cachedGitPriors.get(entry.identityPath);

        if (cachedPrior !== undefined) {
          return cachedPrior;
        }

        const prior = this.getGitPrior(entry);

        this.cachedGitPriors.set(entry.identityPath, prior);
        return prior;
      },
      getGitTrackingState: (entry) => {
        const cachedState = this.cachedGitTrackingStates.get(entry.identityPath);

        if (cachedState !== undefined) {
          return cachedState;
        }

        const gitTrackingState = this.gitTrackedIndex.getTrackingState(entry.uri);

        this.cachedGitTrackingStates.set(entry.identityPath, gitTrackingState);
        return gitTrackingState;
      },
    };
  }

  recordExplicitOpen(identityPath: string): void {
    const now = Date.now();

    this.rememberVisit(identityPath, now);
    this.frecencyStore.recordOpen(identityPath, {
      now,
      weight: this.config.visits.explicitOpenWeight,
    });
  }

  async inspectContributorRelationships(): Promise<
    readonly WorkspaceContributorRelationshipSnapshot[]
  > {
    return this.contributorRelationshipIndex.inspectWorkspaceFolders();
  }

  async inspectContributorRelationshipsForSelection(
    selectedContributorKeysByWorkspaceFolderPath: ReadonlyMap<string, string>,
  ): Promise<readonly WorkspaceContributorRelationshipSnapshot[]> {
    return this.contributorRelationshipIndex.inspectWorkspaceFoldersForSelection(
      selectedContributorKeysByWorkspaceFolderPath,
    );
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
    this.frecencyStore.updateOptions({
      ...config.frecency,
      log: this.log,
    });
    this.gitTrackedIndex.updateConfig(config.git);
    this.cachedGitPriors.clear();
    this.cachedGitTrackingStates.clear();
    this.scheduleImplicitOpen(vscode.window.activeTextEditor);
    this.emitter.fire();
  }

  private scheduleImplicitOpen(editor: vscode.TextEditor | undefined): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    const identityPath = editor ? toWorkspacePathIdentity(editor.document.uri) : undefined;

    if (!identityPath) {
      return;
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.recordImplicitOpen(identityPath);
    }, this.config.visits.editorDwellMs);
  }

  private recordImplicitOpen(identityPath: string): void {
    const now = Date.now();

    if (this.isDuplicateVisit(identityPath, now)) {
      return;
    }

    this.rememberVisit(identityPath, now);
    this.frecencyStore.recordOpen(identityPath, {
      now,
      weight: this.config.visits.implicitOpenWeight,
    });
  }

  private isDuplicateVisit(identityPath: string, now: number): boolean {
    const lastVisit = this.recentVisits.get(identityPath);

    return (
      typeof lastVisit === "number" && now - lastVisit < this.config.visits.duplicateVisitWindowMs
    );
  }

  private rememberVisit(identityPath: string, now: number): void {
    this.recentVisits.set(identityPath, now);

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
      ? scoreContributorFile(contributorState.profile, repoRelativePath).total
      : 0;
    const sessionPrior = sessionState
      ? scoreGitSessionOverlay(
          sessionState.sessionOverlay,
          repoRelativePath,
          sessionState.areaMetadata,
        )
      : 0;

    return contributorPrior + 1.6 * sessionPrior;
  }

  private trackPickerDependencyReady(
    key: keyof typeof this.pickerReadiness,
    readyPromise: Promise<void>,
  ): Promise<void> {
    return readyPromise.then(() => {
      if (this.pickerReadiness[key]) {
        return;
      }

      this.pickerReadiness[key] = true;
      this.emitter.fire();
    });
  }
}

function getActivePath(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;

  return activeEditor ? toRelativeWorkspacePath(activeEditor.document.uri) : undefined;
}

function getActiveIdentityPath(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;

  return activeEditor ? toWorkspacePathIdentity(activeEditor.document.uri) : undefined;
}

function getActiveWorkspaceFolderPath(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  const workspaceFolder = activeEditor
    ? vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    : undefined;

  return workspaceFolder?.uri.fsPath;
}

function collectOpenIdentityPaths(): Set<string> {
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
  const identityPath = toWorkspacePathIdentity(uri);

  if (identityPath) {
    paths.add(identityPath);
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
