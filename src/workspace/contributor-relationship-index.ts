import * as vscode from "vscode";
import {
  buildContributorRelationshipGraph,
  createContributorIdentity,
  formatContributorIdentity,
  rankContributorRelationships,
  type ContributorIdentity,
  type ContributorRelationship,
  type ContributorSelector,
  type ContributorSummary,
  type ContributorTouch,
} from "./contributor-relationship-model";
import { loadTrackedPaths, resolveRepoRoot, runGit } from "./git-utils";
import { normalizePath } from "./workspace-path";

const COMMIT_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const MAX_RELATIONSHIPS = 12;
const MAX_TOP_CONTRIBUTORS = 8;

export type WorkspaceContributorRelationshipStatus =
  | "ready"
  | "not-git"
  | "no-history"
  | "no-current-contributor";

export interface WorkspaceContributorRelationshipSnapshot {
  readonly workspaceFolderName: string;
  readonly workspaceFolderPath: string;
  readonly repoRootPath?: string;
  readonly status: WorkspaceContributorRelationshipStatus;
  readonly configuredContributor?: ContributorSelector;
  readonly currentContributor?: ContributorIdentity;
  readonly currentContributorFileCount: number;
  readonly currentContributorCommitCount: number;
  readonly currentContributorProfileWeight: number;
  readonly trackedFileCount: number;
  readonly contributorCount: number;
  readonly relationships: readonly ContributorRelationship[];
  readonly topContributors: readonly ContributorSummary[];
}

export class ContributorRelationshipIndex implements vscode.Disposable {
  private readonly snapshots = new Map<string, Promise<WorkspaceContributorRelationshipSnapshot>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log?: (message: string) => void) {
    const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
    const refsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/refs/**");
    const packedRefsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/packed-refs");
    const invalidate = (): void => {
      this.snapshots.clear();
    };

    this.disposables.push(
      headWatcher,
      refsWatcher,
      packedRefsWatcher,
      headWatcher.onDidCreate(invalidate),
      headWatcher.onDidChange(invalidate),
      headWatcher.onDidDelete(invalidate),
      refsWatcher.onDidCreate(invalidate),
      refsWatcher.onDidChange(invalidate),
      refsWatcher.onDidDelete(invalidate),
      packedRefsWatcher.onDidCreate(invalidate),
      packedRefsWatcher.onDidChange(invalidate),
      packedRefsWatcher.onDidDelete(invalidate),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    );
  }

  async inspectWorkspaceFolders(): Promise<readonly WorkspaceContributorRelationshipSnapshot[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    return Promise.all(folders.map((folder) => this.getSnapshot(folder)));
  }

  dispose(): void {
    this.snapshots.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private getSnapshot(
    folder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceContributorRelationshipSnapshot> {
    const existingSnapshot = this.snapshots.get(folder.uri.fsPath);

    if (existingSnapshot) {
      return existingSnapshot;
    }

    const snapshotPromise = loadWorkspaceContributorRelationshipSnapshot(folder, this.log).catch(
      (error) => {
        this.snapshots.delete(folder.uri.fsPath);
        throw error;
      },
    );

    this.snapshots.set(folder.uri.fsPath, snapshotPromise);

    return snapshotPromise;
  }
}

async function loadWorkspaceContributorRelationshipSnapshot(
  folder: vscode.WorkspaceFolder,
  log?: (message: string) => void,
): Promise<WorkspaceContributorRelationshipSnapshot> {
  if (folder.uri.scheme !== "file") {
    return createEmptySnapshot(folder, "not-git");
  }

  let repoRootPath: string;

  try {
    repoRootPath = await resolveRepoRoot(folder.uri.fsPath);
  } catch {
    return createEmptySnapshot(folder, "not-git");
  }

  const [trackedPaths, contributorTouches, configuredContributor] = await Promise.all([
    loadTrackedPaths(repoRootPath),
    loadContributorTouches(repoRootPath),
    loadConfiguredContributor(repoRootPath),
  ]);
  const graph = buildContributorRelationshipGraph(contributorTouches, {
    currentContributor: configuredContributor,
    trackedPaths,
  });
  const topContributors = graph.contributors.slice(0, MAX_TOP_CONTRIBUTORS);

  if (!graph.contributors.length) {
    return {
      ...createEmptySnapshot(folder, "no-history"),
      repoRootPath,
      configuredContributor,
      trackedFileCount: trackedPaths.size,
      topContributors,
      currentContributorCommitCount: 0,
      currentContributorProfileWeight: 0,
    };
  }

  const currentContributorSummary = graph.currentContributorKey
    ? graph.contributors.find((summary) => summary.contributor.key === graph.currentContributorKey)
    : undefined;

  if (!currentContributorSummary) {
    return {
      ...createEmptySnapshot(folder, "no-current-contributor"),
      repoRootPath,
      configuredContributor,
      trackedFileCount: trackedPaths.size,
      contributorCount: graph.contributors.length,
      topContributors,
      currentContributorCommitCount: 0,
      currentContributorProfileWeight: 0,
    };
  }

  const relationships = rankContributorRelationships(
    graph,
    currentContributorSummary.contributor.key,
    {
      limit: MAX_RELATIONSHIPS,
    },
  );

  log?.(
    `Loaded contributor relationships for ${folder.name}: current=${formatContributorIdentity(
      currentContributorSummary.contributor,
    )}, contributors=${graph.contributors.length}, relationships=${relationships.length}.`,
  );

  return {
    workspaceFolderName: folder.name,
    workspaceFolderPath: folder.uri.fsPath,
    repoRootPath,
    status: "ready",
    configuredContributor,
    currentContributor: currentContributorSummary.contributor,
    currentContributorFileCount: currentContributorSummary.touchedFileCount,
    currentContributorCommitCount: currentContributorSummary.touchedCommitCount,
    currentContributorProfileWeight: currentContributorSummary.profileWeight,
    trackedFileCount: trackedPaths.size,
    contributorCount: graph.contributors.length,
    relationships,
    topContributors,
  };
}

async function loadContributorTouches(repoRootPath: string): Promise<readonly ContributorTouch[]> {
  const stdout = await runGit(repoRootPath, [
    "log",
    "--use-mailmap",
    "--no-merges",
    `--format=${COMMIT_SEPARATOR}%aN${FIELD_SEPARATOR}%aE${FIELD_SEPARATOR}%at`,
    "--name-only",
    "--",
  ]);
  const contributorTouches: ContributorTouch[] = [];

  for (const rawCommit of stdout.split(COMMIT_SEPARATOR)) {
    if (!rawCommit.trim()) {
      continue;
    }

    const lines = rawCommit.split(/\r?\n/);
    const header = lines[0]?.trim();

    if (!header) {
      continue;
    }

    const [authorName, authorEmail, authoredAtUnixSeconds] = header.split(FIELD_SEPARATOR);
    const touchedPaths: string[] = [];
    const seenPaths = new Set<string>();

    for (const line of lines.slice(1)) {
      const normalizedPath = normalizePath(line.trim());

      if (!normalizedPath || seenPaths.has(normalizedPath)) {
        continue;
      }

      seenPaths.add(normalizedPath);
      touchedPaths.push(normalizedPath);
    }

    if (!touchedPaths.length) {
      continue;
    }

    contributorTouches.push({
      contributor: createContributorIdentity(authorName, authorEmail),
      committedAtMs: Number.parseInt(authoredAtUnixSeconds ?? "", 10) * 1000,
      touchedPaths,
    });
  }

  return contributorTouches;
}

async function loadConfiguredContributor(
  repoRootPath: string,
): Promise<ContributorSelector | undefined> {
  const [name, email] = await Promise.all([
    readGitConfig(repoRootPath, "user.name"),
    readGitConfig(repoRootPath, "user.email"),
  ]);

  if (!name && !email) {
    return undefined;
  }

  return {
    name,
    email,
  };
}

async function readGitConfig(repoRootPath: string, key: string): Promise<string | undefined> {
  try {
    const value = (await runGit(repoRootPath, ["config", "--get", key])).trim();

    return value || undefined;
  } catch {
    return undefined;
  }
}

function createEmptySnapshot(
  folder: vscode.WorkspaceFolder,
  status: WorkspaceContributorRelationshipStatus,
): WorkspaceContributorRelationshipSnapshot {
  return {
    workspaceFolderName: folder.name,
    workspaceFolderPath: folder.uri.fsPath,
    status,
    currentContributorFileCount: 0,
    currentContributorCommitCount: 0,
    currentContributorProfileWeight: 0,
    trackedFileCount: 0,
    contributorCount: 0,
    relationships: [],
    topContributors: [],
  };
}
