import * as vscode from "vscode";
import { type SearchRuntime, type SearchRuntimeStatus } from "../../search";
import {
  formatBetterGoToFileStatusText,
  formatBetterGoToFileStatusTooltip,
} from "./better-go-to-file-status-format";

const STATUS_BAR_REFRESH_INTERVAL_MS = 30_000;

export function createBetterGoToFileStatusItem(runtime: SearchRuntime): vscode.Disposable {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);

  statusItem.name = "Better Go To File";
  statusItem.command = "betterGoToFile.open";
  statusItem.accessibilityInformation = {
    label: "Better Go To File status",
    role: "button",
  };

  const update = (): void => {
    const status = runtime.getStatus();

    if (status.index.workspaceFolderCount <= 0) {
      statusItem.hide();
      return;
    }

    applyStatusPresentation(statusItem, status);
    statusItem.show();
  };

  const interval = setInterval(() => {
    update();
  }, STATUS_BAR_REFRESH_INTERVAL_MS);

  update();

  return vscode.Disposable.from(
    statusItem,
    runtime.onDidChange(() => {
      update();
    }),
    {
      dispose: () => {
        clearInterval(interval);
      },
    },
  );
}

function applyStatusPresentation(
  statusItem: vscode.StatusBarItem,
  status: SearchRuntimeStatus,
): void {
  statusItem.text = formatBetterGoToFileStatusText(status);
  const tooltip = new vscode.MarkdownString(formatBetterGoToFileStatusTooltip(status), true);

  tooltip.isTrusted = {
    enabledCommands: [
      "betterGoToFile.open",
      "betterGoToFile.openContributorRelationshipsView",
      "betterGoToFile.openDebug",
      "betterGoToFile.reindex",
    ],
  };
  tooltip.supportThemeIcons = true;
  statusItem.tooltip = tooltip;
}
