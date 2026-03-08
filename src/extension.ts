import * as vscode from "vscode";
import { loadFileIconResolver } from "./file-icons";
import type { FileEntry } from "./file-entry";
import type { GitignoredVisibility } from "./gitignored-visibility";
import { type FilePickItem, toQuickPickItems } from "./file-search";
import { SearchRuntime } from "./search-runtime";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Better Go To File");
  const gitignoredIconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "gitignored-file.svg",
  );
  const runtime = new SearchRuntime(context, (message) => {
    outputChannel.appendLine(`[search] ${message}`);
  });

  context.subscriptions.push(
    outputChannel,
    runtime,
    vscode.commands.registerCommand("betterGoToFile.open", async () => {
      await showBetterGoToFile(outputChannel, runtime, gitignoredIconPath);
    }),
    vscode.commands.registerCommand("betterGoToFile.inspectIcons", async () => {
      await inspectIcons(outputChannel, runtime);
    }),
  );
}

export function deactivate(): void {}

async function showBetterGoToFile(
  outputChannel: vscode.OutputChannel,
  runtime: SearchRuntime,
  gitignoredIconPath: vscode.Uri,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage("Open a workspace folder to use Better Go To File.");
    return;
  }

  const quickPick = vscode.window.createQuickPick<FilePickItem>();
  const quickPickWithSort = quickPick as vscode.QuickPick<FilePickItem> & {
    sortByLabel?: boolean;
  };

  quickPick.placeholder =
    "Search files, content, and symbols (append : to go to line or @ to go to symbol)";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = false;
  quickPick.ignoreFocusOut = false;
  quickPickWithSort.sortByLabel = false;
  quickPick.busy = true;
  quickPick.show();

  try {
    const log = (message: string): void => {
      outputChannel.appendLine(`[icons] ${message}`);
    };
    await runtime.ready();
    const entries = runtime.getEntries();
    const fileIconResolver = await loadFileIconResolver(log);
    const resolveFileIcon = fileIconResolver?.resolve.bind(fileIconResolver);

    if (!fileIconResolver) {
      log("Using generic fallback icons in the picker.");
    }

    quickPick.items = toQuickPickItems(
      entries,
      quickPick.value,
      runtime.buildRankingContext(),
      resolveFileIcon,
      gitignoredIconPath,
      getGitignoredVisibility(),
      getShowScores(),
    );
    quickPick.busy = false;

    quickPick.onDidChangeValue((value) => {
      quickPick.items = toQuickPickItems(
        entries,
        value,
        runtime.buildRankingContext(),
        resolveFileIcon,
        gitignoredIconPath,
        getGitignoredVisibility(),
        getShowScores(),
      );
    });

    quickPick.onDidAccept(async () => {
      const selectedItem = quickPick.selectedItems[0];

      if (!selectedItem?.entry) {
        return;
      }

      runtime.recordExplicitOpen(selectedItem.entry.relativePath);
      quickPick.hide();
      await vscode.window.showTextDocument(selectedItem.entry.uri, { preview: false });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    quickPick.items = [
      {
        label: "Unable to load files",
        description: message,
        alwaysShow: true,
      },
    ];
    quickPick.busy = false;
  }

  quickPick.onDidHide(() => {
    quickPick.dispose();
  });
}

async function inspectIcons(
  outputChannel: vscode.OutputChannel,
  runtime: SearchRuntime,
): Promise<void> {
  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`[inspect] ${new Date().toISOString()}`);

  const log = (message: string): void => {
    outputChannel.appendLine(`[icons] ${message}`);
  };

  try {
    await runtime.ready();
    const entries = runtime.getEntries();
    const fileIconResolver = await loadFileIconResolver(log);

    outputChannel.appendLine(`[inspect] workspaceFiles=${entries.length}`);

    if (!fileIconResolver) {
      void vscode.window.showWarningMessage(
        "Better Go To File could not resolve the active file icon theme. See the output channel for details.",
      );
      return;
    }

    for (const entry of pickIconSamples(entries)) {
      outputChannel.appendLine(`[sample] ${fileIconResolver.describe(entry)}`);
    }

    void vscode.window.showInformationMessage(
      "Better Go To File icon diagnostics were written to the output channel.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    outputChannel.appendLine(`[inspect] failed: ${message}`);
    void vscode.window.showErrorMessage(`Better Go To File icon diagnostics failed: ${message}`);
  }
}

function pickIconSamples(entries: readonly FileEntry[]): FileEntry[] {
  const preferredBasenames = new Set([".env", ".gitignore"]);
  const preferredExtensions = [".tsx", ".json", ".ts", ".js"];
  const samples: FileEntry[] = [];

  for (const entry of entries) {
    if (samples.length >= 6) {
      break;
    }

    if (preferredBasenames.has(entry.searchBasename)) {
      samples.push(entry);
      continue;
    }

    if (preferredExtensions.some((extension) => entry.searchBasename.endsWith(extension))) {
      samples.push(entry);
    }
  }

  if (samples.length < 6) {
    for (const entry of entries) {
      if (samples.length >= 6) {
        break;
      }

      if (!samples.includes(entry)) {
        samples.push(entry);
      }
    }
  }

  return samples;
}

function getGitignoredVisibility(): GitignoredVisibility {
  const configuredValue = vscode.workspace
    .getConfiguration("betterGoToFile")
    .get<GitignoredVisibility>("gitignoredVisibility", "auto");

  if (configuredValue === "show" || configuredValue === "auto" || configuredValue === "hide") {
    return configuredValue;
  }

  return "auto";
}

function getShowScores(): boolean {
  return vscode.workspace.getConfiguration("betterGoToFile").get<boolean>("showScores", false);
}
