import * as vscode from "vscode";
import { inspectIcons } from "./commands/inspect-icons";
import { ContributorRelationshipsViewController } from "./commands/open-contributor-relationships-view";
import { showBetterGoToFile } from "./commands/open-file-picker";
import { createBetterGoToFileStatusItem } from "./status/better-go-to-file-status-item";
import { BetterGoToFileConfigStore } from "../config";
import { SearchRuntime } from "../search";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Better Go To File");
  const configStore = new BetterGoToFileConfigStore();
  const runtime = new SearchRuntime(context, configStore, (message) => {
    outputChannel.appendLine(`[search] ${message}`);
  });
  const contributorRelationshipsView = new ContributorRelationshipsViewController(runtime);

  context.subscriptions.push(
    outputChannel,
    runtime,
    contributorRelationshipsView,
    createBetterGoToFileStatusItem(runtime),
    vscode.commands.registerCommand("betterGoToFile.open", async () => {
      await showBetterGoToFile(outputChannel, runtime);
    }),
    vscode.commands.registerCommand("betterGoToFile.openDebug", async () => {
      await showBetterGoToFile(outputChannel, runtime, { debugScoring: true });
    }),
    vscode.commands.registerCommand("betterGoToFile.reindex", async () => {
      outputChannel.appendLine("[search] Manual reindex requested.");
      await runtime.refreshIndex();
    }),
    vscode.commands.registerCommand("betterGoToFile.inspectIcons", async () => {
      await inspectIcons(outputChannel, runtime);
    }),
    vscode.commands.registerCommand("betterGoToFile.openContributorRelationshipsView", async () => {
      await contributorRelationshipsView.show();
    }),
  );
}

export function deactivate(): void {}
