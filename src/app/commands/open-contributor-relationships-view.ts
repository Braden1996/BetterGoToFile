import * as vscode from "vscode";
import { SearchRuntime } from "../../search";
import type { WorkspaceContributorRelationshipSnapshot } from "../../workspace";
import {
  renderContributorRelationshipsErrorHtml,
  renderContributorRelationshipsLoadingHtml,
  renderContributorRelationshipsViewHtml,
} from "../views/contributor-relationships-view-html";

const PANEL_TITLE = "Better Go To File: Contributor Relationships";
const PANEL_VIEW_TYPE = "betterGoToFile.contributorRelationships";

interface SelectContributorMessage {
  readonly type: "selectContributor";
  readonly workspaceFolderPath: string;
  readonly contributorKey?: string;
}

export class ContributorRelationshipsViewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly selectedContributorKeysByWorkspaceFolderPath = new Map<string, string>();
  private refreshVersion = 0;

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
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleWebviewMessage(message);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    return this.panel;
  }

  private async refresh(panel: vscode.WebviewPanel): Promise<void> {
    const refreshVersion = ++this.refreshVersion;
    panel.webview.html = renderContributorRelationshipsLoadingHtml();

    try {
      const snapshots = await this.runtime.inspectContributorRelationshipsForSelection(
        this.selectedContributorKeysByWorkspaceFolderPath,
      );

      if (this.panel !== panel || refreshVersion !== this.refreshVersion) {
        return;
      }

      this.pruneStaleSelections(snapshots);

      panel.title =
        snapshots.length === 1
          ? `${PANEL_TITLE} (${snapshots[0]?.workspaceFolderName ?? "Workspace"})`
          : PANEL_TITLE;
      panel.webview.html = renderContributorRelationshipsViewHtml(snapshots);
    } catch (error) {
      if (this.panel !== panel || refreshVersion !== this.refreshVersion) {
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";

      panel.webview.html = renderContributorRelationshipsErrorHtml(message);
    }
  }

  private async handleWebviewMessage(message: unknown): Promise<void> {
    if (!this.panel || !isSelectContributorMessage(message)) {
      return;
    }

    if (message.contributorKey) {
      this.selectedContributorKeysByWorkspaceFolderPath.set(
        message.workspaceFolderPath,
        message.contributorKey,
      );
    } else {
      this.selectedContributorKeysByWorkspaceFolderPath.delete(message.workspaceFolderPath);
    }

    await this.refresh(this.panel);
  }

  private pruneStaleSelections(
    snapshots: readonly WorkspaceContributorRelationshipSnapshot[],
  ): void {
    for (const snapshot of snapshots) {
      const selectedContributorKey = this.selectedContributorKeysByWorkspaceFolderPath.get(
        snapshot.workspaceFolderPath,
      );

      if (!selectedContributorKey) {
        continue;
      }

      const stillExists = snapshot.contributors.some(
        (summary) => summary.contributor.key === selectedContributorKey,
      );

      if (!stillExists) {
        this.selectedContributorKeysByWorkspaceFolderPath.delete(snapshot.workspaceFolderPath);
      }
    }
  }
}

function isSelectContributorMessage(message: unknown): message is SelectContributorMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<SelectContributorMessage>;

  return (
    candidate.type === "selectContributor" &&
    typeof candidate.workspaceFolderPath === "string" &&
    (candidate.contributorKey === undefined || typeof candidate.contributorKey === "string")
  );
}
