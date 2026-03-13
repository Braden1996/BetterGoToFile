import * as vscode from "vscode";
import { SearchRuntime } from "../../search";
import {
  renderContributorRelationshipsErrorHtml,
  renderContributorRelationshipsLoadingHtml,
  renderContributorRelationshipsViewHtml,
} from "../views/contributor-relationships-view-html";

const PANEL_TITLE = "Better Go To File: Contributor Relationships";
const PANEL_VIEW_TYPE = "betterGoToFile.contributorRelationships";

export class ContributorRelationshipsViewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly runtime: SearchRuntime) {}

  async show(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage(
        "Open a workspace folder to inspect contributor relationships.",
      );
      return;
    }

    const panel = this.ensurePanel();

    panel.reveal(vscode.ViewColumn.Active);
    await this.refresh(panel);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Active,
      {
        enableFindWidget: true,
        enableScripts: false,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    return this.panel;
  }

  private async refresh(panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.html = renderContributorRelationshipsLoadingHtml();

    try {
      const snapshots = await this.runtime.inspectContributorRelationships();

      if (this.panel !== panel) {
        return;
      }

      panel.title =
        snapshots.length === 1
          ? `${PANEL_TITLE} (${snapshots[0]?.workspaceFolderName ?? "Workspace"})`
          : PANEL_TITLE;
      panel.webview.html = renderContributorRelationshipsViewHtml(snapshots);
    } catch (error) {
      if (this.panel !== panel) {
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";

      panel.webview.html = renderContributorRelationshipsErrorHtml(message);
    }
  }
}
