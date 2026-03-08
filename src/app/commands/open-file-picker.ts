import * as vscode from "vscode";
import { createGitignoredFileIconPath, loadFileIconResolver } from "../../icons";
import { type FilePickItem, SearchRuntime, toQuickPickItems } from "../../search";

export async function showBetterGoToFile(
  outputChannel: vscode.OutputChannel,
  runtime: SearchRuntime,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage("Open a workspace folder to use Better Go To File.");
    return;
  }

  const quickPick = vscode.window.createQuickPick<FilePickItem>();
  const disposables: vscode.Disposable[] = [];
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
    const fileIconResolver = await loadFileIconResolver(log);
    const resolveFileIcon = fileIconResolver?.resolve.bind(fileIconResolver);
    const fallbackGitignoredIconPath = createGitignoredFileIconPath();
    const resolveGitignoredIcon =
      fileIconResolver?.resolveGitignored.bind(fileIconResolver) ??
      (() => fallbackGitignoredIconPath);
    const updateItems = (): void => {
      quickPick.items = toQuickPickItems(
        runtime.getEntries(),
        quickPick.value,
        runtime.buildRankingContext(),
        resolveFileIcon,
        resolveGitignoredIcon,
        runtime.getConfig(),
      );
    };

    if (!fileIconResolver) {
      log("Using generic fallback icons in the picker.");
    }

    updateItems();
    quickPick.busy = false;

    disposables.push(
      quickPick.onDidChangeValue((value) => {
        quickPick.items = toQuickPickItems(
          runtime.getEntries(),
          value,
          runtime.buildRankingContext(),
          resolveFileIcon,
          resolveGitignoredIcon,
          runtime.getConfig(),
        );
      }),
      runtime.onDidChange(() => {
        updateItems();
      }),
    );

    disposables.push(
      quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0];

        if (!selectedItem?.entry) {
          return;
        }

        runtime.recordExplicitOpen(selectedItem.entry.relativePath);
        quickPick.hide();
        await vscode.window.showTextDocument(selectedItem.entry.uri, { preview: false });
      }),
    );
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
    for (const disposable of disposables) {
      disposable.dispose();
    }

    quickPick.dispose();
  });
}
