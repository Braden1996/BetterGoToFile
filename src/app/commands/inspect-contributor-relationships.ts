import * as vscode from "vscode";
import {
  formatContributorIdentity,
  type ContributorRelationship,
  type ContributorSelector,
  type ContributorSummary,
  type WorkspaceContributorRelationshipSnapshot,
} from "../../workspace";
import { SearchRuntime } from "../../search";

export async function inspectContributorRelationships(
  outputChannel: vscode.OutputChannel,
  runtime: SearchRuntime,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage(
      "Open a workspace folder to inspect contributor relationships.",
    );
    return;
  }

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`[inspect] ${new Date().toISOString()}`);

  try {
    const snapshots = await runtime.inspectContributorRelationships();

    if (!snapshots.length) {
      outputChannel.appendLine("[contributors] No workspace folders are open.");
    }

    snapshots.forEach((snapshot, index) => {
      if (index > 0) {
        outputChannel.appendLine("");
      }

      writeSnapshot(outputChannel, snapshot);
    });

    void vscode.window.showInformationMessage(
      "Better Go To File contributor relationships were written to the output channel.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    outputChannel.appendLine(`[contributors] failed: ${message}`);
    void vscode.window.showErrorMessage(
      `Better Go To File contributor relationship inspection failed: ${message}`,
    );
  }
}

function writeSnapshot(
  outputChannel: vscode.OutputChannel,
  snapshot: WorkspaceContributorRelationshipSnapshot,
): void {
  outputChannel.appendLine(`[contributors] workspace=${snapshot.workspaceFolderName}`);

  if (snapshot.repoRootPath) {
    outputChannel.appendLine(`[contributors] repo=${snapshot.repoRootPath}`);
  }

  outputChannel.appendLine(
    `[contributors] status=${snapshot.status} trackedFiles=${snapshot.trackedFileCount} contributors=${snapshot.contributorCount}`,
  );

  if (snapshot.status === "not-git") {
    outputChannel.appendLine(
      "[contributors] No Git repository was found for this workspace folder.",
    );
    return;
  }

  if (snapshot.status === "no-history") {
    outputChannel.appendLine(
      "[contributors] No contributor history was found after filtering to currently tracked files.",
    );
    return;
  }

  if (snapshot.status === "no-current-contributor") {
    outputChannel.appendLine(
      `[contributors] configuredContributor=${formatConfiguredContributor(
        snapshot.configuredContributor,
      )} was not found in the repository history.`,
    );
    writeTopContributors(outputChannel, snapshot.topContributors);
    return;
  }

  if (!snapshot.currentContributor) {
    outputChannel.appendLine(
      "[contributors] No current contributor could be resolved for this workspace folder.",
    );
    return;
  }

  outputChannel.appendLine(
    `[contributors] current=${formatContributorIdentity(snapshot.currentContributor)} currentFiles=${snapshot.currentContributorFileCount} currentCommits=${snapshot.currentContributorCommitCount} areaFast=${formatDecimal(snapshot.currentContributorAreaFastWeight)} areaSlow=${formatDecimal(snapshot.currentContributorAreaSlowWeight)} fileFast=${formatDecimal(snapshot.currentContributorFileFastWeight)} fileSlow=${formatDecimal(snapshot.currentContributorFileSlowWeight)}`,
  );

  if (!snapshot.relationships.length) {
    outputChannel.appendLine(
      "[relationship] No overlapping contributors were found for the configured contributor.",
    );
  } else {
    snapshot.relationships.forEach((relationship) => {
      writeRelationship(outputChannel, relationship);
    });
  }

  writeTopContributors(outputChannel, snapshot.topContributors);
}

function writeRelationship(
  outputChannel: vscode.OutputChannel,
  relationship: ContributorRelationship,
): void {
  const samples =
    relationship.sampleSharedAreas.length > 0 ? relationship.sampleSharedAreas.join(", ") : "none";

  outputChannel.appendLine(
    `[relationship] contributor=${formatContributorIdentity(
      relationship.contributor,
    )} score=${formatDecimal(relationship.relationshipScore)} activity=${formatPercent(
      relationship.activityFactor,
    )} fast=${formatPercent(relationship.fastSimilarity)} slow=${formatPercent(
      relationship.slowSimilarity,
    )} broadnessPenalty=${formatPercent(relationship.broadnessPenalty)} broadness=${formatPercent(
      relationship.contributorBroadness,
    )} sharedAreas=${relationship.sharedAreaCount} contributorFiles=${relationship.contributorFileCount} contributorCommits=${relationship.contributorCommitCount} recentCommits=${relationship.contributorRecentCommitCount} lastActiveDays=${formatDecimal(
      relationship.contributorLastCommitAgeDays,
    )} samples=${samples}`,
  );
}

function writeTopContributors(
  outputChannel: vscode.OutputChannel,
  topContributors: readonly ContributorSummary[],
): void {
  if (!topContributors.length) {
    return;
  }

  outputChannel.appendLine("[contributors] topContributors");

  topContributors.forEach((summary) => {
    outputChannel.appendLine(
      `[top] commits=${summary.touchedCommitCount} recentCommits=${summary.recentCommitCount} lastActiveDays=${formatDecimal(
        summary.lastCommitAgeDays,
      )} files=${summary.touchedFileCount} areaFast=${formatDecimal(
        summary.areaFastWeight,
      )} areaSlow=${formatDecimal(summary.areaSlowWeight)} fileFast=${formatDecimal(
        summary.fileFastWeight,
      )} fileSlow=${formatDecimal(summary.fileSlowWeight)} broadness=${formatPercent(
        summary.broadness,
      )} contributor=${formatContributorIdentity(summary.contributor)}`,
    );
  });
}

function formatConfiguredContributor(contributor?: ContributorSelector): string {
  if (!contributor?.name && !contributor?.email) {
    return "not configured";
  }

  if (contributor.email && contributor.name && contributor.name !== contributor.email) {
    return `${contributor.name} <${contributor.email}>`;
  }

  return contributor.name ?? contributor.email ?? "not configured";
}

function formatDecimal(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
