import * as vscode from "vscode";
import { inspectIcons } from "./commands/inspect-icons";
import { inspectContributorRelationships } from "./commands/inspect-contributor-relationships";
import { showBetterGoToFile } from "./commands/open-file-picker";
import { BetterGoToFileConfigStore } from "../config";
import { SearchRuntime } from "../search";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Better Go To File");
  const configStore = new BetterGoToFileConfigStore();
  const runtime = new SearchRuntime(context, configStore, (message) => {
    outputChannel.appendLine(`[search] ${message}`);
  });

  context.subscriptions.push(
    outputChannel,
    runtime,
    vscode.commands.registerCommand("betterGoToFile.open", async () => {
      await showBetterGoToFile(outputChannel, runtime);
    }),
    vscode.commands.registerCommand("betterGoToFile.inspectIcons", async () => {
      await inspectIcons(outputChannel, runtime);
    }),
    vscode.commands.registerCommand("betterGoToFile.inspectContributorRelationships", async () => {
      await inspectContributorRelationships(outputChannel, runtime);
    }),
  );
}

export function deactivate(): void {}
