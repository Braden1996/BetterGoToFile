import {
  formatContributorIdentity,
  type ContributorIdentity,
  type ContributorRelationship,
  type ContributorSelector,
  type ContributorSummary,
} from "../../workspace/contributor-relationship-model";
import type { WorkspaceContributorRelationshipSnapshot } from "../../workspace/contributor-relationship-index";

const EMPTY_VALUE = "-";
const PANEL_TITLE = "Better Go To File: Contributor Relationships";

interface ContributorTableRow {
  readonly isCurrentContributor: boolean;
  readonly relationship?: ContributorRelationship;
  readonly summary: ContributorSummary;
}

export function renderContributorRelationshipsViewHtml(
  snapshots: readonly WorkspaceContributorRelationshipSnapshot[],
  nowMs = Date.now(),
): string {
  const workspaceCount = snapshots.length;
  const readyCount = snapshots.filter((snapshot) => snapshot.status === "ready").length;
  const generatedAt = new Date(nowMs).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const sections = snapshots.map((snapshot) => renderWorkspaceSection(snapshot, nowMs)).join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(PANEL_TITLE)}</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--vscode-foreground);
        font: 13px/1.5 var(--vscode-font-family);
        background:
          radial-gradient(circle at top left, color-mix(in srgb, var(--vscode-button-background) 16%, transparent), transparent 32%),
          linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 26%, transparent), transparent 22%),
          var(--vscode-editor-background);
      }

      code,
      .mono {
        font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      }

      .page {
        max-width: 1680px;
        margin: 0 auto;
        padding: 24px;
      }

      .hero {
        padding: 20px 22px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, transparent);
        border-radius: 18px;
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--vscode-editorInfo-foreground) 10%, transparent), transparent 55%),
          color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
      }

      .hero h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
      }

      .lede {
        margin: 12px 0 0;
        max-width: 78ch;
        color: var(--vscode-descriptionForeground);
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      }

      .workspace {
        margin-top: 22px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        border-radius: 18px;
        overflow: hidden;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      }

      .workspace-header {
        padding: 18px 22px 14px;
        border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 8%, transparent), transparent 65%),
          color-mix(in srgb, var(--vscode-editor-background) 55%, transparent);
      }

      .workspace-title-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .workspace h2 {
        margin: 0;
        font-size: 17px;
      }

      .workspace-meta {
        margin-top: 8px;
        color: var(--vscode-descriptionForeground);
      }

      .workspace-controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }

      .select-control {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--vscode-descriptionForeground);
      }

      .select-control select {
        min-width: 240px;
        max-width: min(420px, 70vw);
        padding: 6px 10px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        border-radius: 10px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-dropdown-background);
      }

      .status-chip {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
        text-transform: capitalize;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 12px;
        padding: 18px 22px 0;
      }

      .summary-card {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
        background: color-mix(in srgb, var(--vscode-sideBar-background) 65%, transparent);
      }

      .summary-label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .summary-value {
        margin-top: 8px;
        font-size: 17px;
        font-weight: 600;
      }

      .summary-note {
        margin-top: 6px;
        color: var(--vscode-descriptionForeground);
      }

      .message {
        margin: 18px 22px 0;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
        background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 75%, transparent);
      }

      .table-wrap {
        margin: 18px 0 0;
        overflow: auto;
        border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1200px;
      }

      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 12px 14px;
        text-align: left;
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      }

      tbody td {
        padding: 12px 14px;
        vertical-align: top;
        border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 58%, transparent);
      }

      tbody tr:hover {
        background: color-mix(in srgb, var(--vscode-list-hoverBackground) 88%, transparent);
      }

      tbody tr.current-row {
        background: color-mix(in srgb, var(--vscode-editorSelectionBackground) 34%, transparent);
      }

      .contributor-cell {
        min-width: 240px;
      }

      .contributor-name {
        font-weight: 600;
      }

      .contributor-meta {
        margin-top: 4px;
        color: var(--vscode-descriptionForeground);
      }

      .contributor-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      .tag {
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
        color: var(--vscode-descriptionForeground);
      }

      .metric {
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      .metric-strong {
        font-weight: 700;
      }

      .areas {
        min-width: 280px;
        color: var(--vscode-descriptionForeground);
      }

      .empty {
        padding: 22px;
        color: var(--vscode-descriptionForeground);
      }

      @media (max-width: 900px) {
        .page {
          padding: 16px;
        }

        .hero,
        .workspace-header,
        .summary-grid,
        .message {
          padding-left: 16px;
          padding-right: 16px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <h1>${escapeHtml(PANEL_TITLE)}</h1>
        <p class="lede">
          Relationship score blends fast and slow shared-area overlap, then scales by recent
          activity and contributor focus. The table keeps those components visible so you can
          understand why someone ranks highly, not just that they do.
        </p>
        <div class="hero-meta">
          <span class="pill"><strong>${formatInteger(workspaceCount)}</strong> workspaces</span>
          <span class="pill"><strong>${formatInteger(readyCount)}</strong> ready relationship models</span>
          <span class="pill">Generated ${escapeHtml(generatedAt)}</span>
        </div>
      </section>
      ${sections || '<section class="workspace"><div class="empty">No workspace folders are open.</div></section>'}
    </main>
    <script>
      const vscode = acquireVsCodeApi();

      document.querySelectorAll("[data-contributor-select]").forEach((select) => {
        select.addEventListener("change", (event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLSelectElement)) {
            return;
          }

          vscode.postMessage({
            type: "selectContributor",
            workspaceFolderPath: target.dataset.workspaceFolderPath,
            contributorKey: target.value || undefined,
          });
        });
      });
    </script>
  </body>
</html>`;
}

export function renderContributorRelationshipsLoadingHtml(): string {
  return renderStatusHtml(
    "Loading contributor relationships...",
    "Building the latest workspace model.",
  );
}

export function renderContributorRelationshipsErrorHtml(message: string): string {
  return renderStatusHtml("Contributor relationships failed to load.", message);
}

function renderStatusHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(PANEL_TITLE)}</title>
    <style>
      body {
        margin: 0;
        color: var(--vscode-foreground);
        font: 13px/1.5 var(--vscode-font-family);
        background: var(--vscode-editor-background);
      }

      .state {
        max-width: 680px;
        margin: 64px auto;
        padding: 24px;
        border-radius: 18px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      }

      h1 {
        margin: 0;
        font-size: 20px;
      }

      p {
        margin: 10px 0 0;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <main class="state">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function renderWorkspaceSection(
  snapshot: WorkspaceContributorRelationshipSnapshot,
  nowMs: number,
): string {
  const cards = buildSummaryCards(snapshot);
  const message = renderWorkspaceMessage(snapshot);
  const rows = buildContributorRows(snapshot);
  const contributorTable =
    rows.length > 0
      ? `<div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contributor</th>
                <th>Relationship</th>
                <th>Fast overlap</th>
                <th>Slow overlap</th>
                <th>Activity</th>
                <th>Focus factor</th>
                <th>Shared areas</th>
                <th>Files</th>
                <th>Commits</th>
                <th>Recent commits</th>
                <th>Last active</th>
                <th>Sample shared areas</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => renderContributorRow(row, nowMs)).join("")}
            </tbody>
          </table>
        </div>`
      : '<div class="empty">No contributor rows are available for this workspace.</div>';

  return `<section class="workspace">
    <div class="workspace-header">
      <div class="workspace-title-row">
        <h2>${escapeHtml(snapshot.workspaceFolderName)}</h2>
        <div class="workspace-controls">
          ${renderContributorSelect(snapshot)}
          <span class="status-chip">${escapeHtml(formatWorkspaceStatus(snapshot.status))}</span>
        </div>
      </div>
      <div class="workspace-meta">
        ${escapeHtml(snapshot.repoRootPath ?? snapshot.workspaceFolderPath)}
      </div>
    </div>
    <div class="summary-grid">
      ${cards.map(renderSummaryCard).join("")}
    </div>
    ${message ? `<div class="message">${message}</div>` : ""}
    ${contributorTable}
  </section>`;
}

function buildSummaryCards(
  snapshot: WorkspaceContributorRelationshipSnapshot,
): readonly { label: string; note?: string; value: string }[] {
  const cards: { label: string; note?: string; value: string }[] = [
    {
      label: "Tracked files",
      value: formatInteger(snapshot.trackedFileCount),
    },
    {
      label: "Contributors",
      value: formatInteger(snapshot.contributorCount),
    },
  ];

  if (snapshot.currentContributor) {
    cards.unshift({
      label: "Selected contributor",
      note: snapshot.currentContributor.email,
      value: formatContributorIdentity(snapshot.currentContributor),
    });
  } else if (snapshot.configuredContributor?.email || snapshot.configuredContributor?.name) {
    cards.unshift({
      label: "Configured contributor",
      value: formatConfiguredContributor(snapshot.configuredContributor),
    });
  } else {
    cards.unshift({
      label: "Contributor",
      value: "Unavailable",
    });
  }

  if (snapshot.status === "ready") {
    cards.push(
      {
        label: "Ranked relationships",
        value: formatInteger(snapshot.relationships.length),
      },
      {
        label: "Current files",
        value: formatInteger(snapshot.currentContributorFileCount),
      },
      {
        label: "Current commits",
        value: formatInteger(snapshot.currentContributorCommitCount),
      },
    );
  }

  return cards;
}

function renderSummaryCard(card: { label: string; note?: string; value: string }): string {
  return `<div class="summary-card">
    <div class="summary-label">${escapeHtml(card.label)}</div>
    <div class="summary-value">${escapeHtml(card.value)}</div>
    ${card.note ? `<div class="summary-note">${escapeHtml(card.note)}</div>` : ""}
  </div>`;
}

function renderWorkspaceMessage(snapshot: WorkspaceContributorRelationshipSnapshot): string {
  if (snapshot.status === "not-git") {
    return "This workspace folder is not backed by Git, so contributor relationships are unavailable.";
  }

  if (snapshot.status === "no-history") {
    return "No contributor history remained after filtering to tracked files.";
  }

  if (snapshot.status === "no-current-contributor") {
    const configuredContributor =
      snapshot.configuredContributor?.email || snapshot.configuredContributor?.name
        ? `Configured contributor <span class="mono">${escapeHtml(
            formatConfiguredContributor(snapshot.configuredContributor),
          )}</span> was not found in repository history.`
        : "A current contributor could not be matched from repository history.";

    return `${configuredContributor} The table below still shows contributor activity and repository breadth.`;
  }

  if (!snapshot.relationships.length) {
    return "No overlapping contributors were found for the selected contributor.";
  }

  return "Rows are sorted by relationship score, with the selected contributor pinned at the top for context.";
}

function renderContributorSelect(snapshot: WorkspaceContributorRelationshipSnapshot): string {
  if (!snapshot.contributors.length) {
    return "";
  }

  const options = [
    !snapshot.currentContributor
      ? '<option value="" selected>Select a contributor</option>'
      : '<option value="">Use detected contributor</option>',
    ...snapshot.contributors.map((summary) => {
      const contributor = summary.contributor;
      const isSelected = contributor.key === snapshot.currentContributor?.key;

      return `<option value="${escapeHtmlAttribute(contributor.key)}"${isSelected ? " selected" : ""}>${escapeHtml(formatContributorIdentity(contributor))}</option>`;
    }),
  ].join("");

  return `<label class="select-control">
    <span>View as</span>
    <select
      data-contributor-select
      data-workspace-folder-path="${escapeHtmlAttribute(snapshot.workspaceFolderPath)}"
      aria-label="Select contributor for ${escapeHtmlAttribute(snapshot.workspaceFolderName)}"
    >
      ${options}
    </select>
  </label>`;
}

function buildContributorRows(
  snapshot: WorkspaceContributorRelationshipSnapshot,
): readonly ContributorTableRow[] {
  const relationshipsByContributorKey = new Map(
    snapshot.relationships.map((relationship) => [relationship.contributor.key, relationship]),
  );

  return [...snapshot.contributors]
    .map((summary) => ({
      isCurrentContributor: summary.contributor.key === snapshot.currentContributor?.key,
      relationship: relationshipsByContributorKey.get(summary.contributor.key),
      summary,
    }))
    .sort(compareContributorTableRows);
}

function compareContributorTableRows(
  left: ContributorTableRow,
  right: ContributorTableRow,
): number {
  if (left.isCurrentContributor !== right.isCurrentContributor) {
    return left.isCurrentContributor ? -1 : 1;
  }

  return (
    (right.relationship?.relationshipScore ?? -1) - (left.relationship?.relationshipScore ?? -1) ||
    right.summary.touchedCommitCount - left.summary.touchedCommitCount ||
    right.summary.recentCommitCount - left.summary.recentCommitCount ||
    formatContributorIdentity(left.summary.contributor).localeCompare(
      formatContributorIdentity(right.summary.contributor),
    )
  );
}

function renderContributorRow(row: ContributorTableRow, nowMs: number): string {
  const relationship = row.relationship;

  return `<tr${row.isCurrentContributor ? ' class="current-row"' : ""}>
    <td class="contributor-cell">${renderContributorCell(row.summary.contributor, row.isCurrentContributor)}</td>
    <td class="metric metric-strong">${relationship ? formatPercent(relationship.relationshipScore) : row.isCurrentContributor ? "Self" : EMPTY_VALUE}</td>
    <td class="metric">${relationship ? formatPercent(relationship.fastSimilarity) : EMPTY_VALUE}</td>
    <td class="metric">${relationship ? formatPercent(relationship.slowSimilarity) : EMPTY_VALUE}</td>
    <td class="metric">${relationship ? formatPercent(relationship.activityFactor) : EMPTY_VALUE}</td>
    <td class="metric">${relationship ? formatPercent(relationship.broadnessPenalty) : EMPTY_VALUE}</td>
    <td class="metric">${relationship ? formatInteger(relationship.sharedAreaCount) : EMPTY_VALUE}</td>
    <td class="metric">${formatInteger(row.summary.touchedFileCount)}</td>
    <td class="metric">${formatInteger(row.summary.touchedCommitCount)}</td>
    <td class="metric">${formatInteger(row.summary.recentCommitCount)}</td>
    <td class="metric">${formatLastActive(row.summary.lastCommitAgeDays, nowMs)}</td>
    <td class="areas">${relationship ? escapeHtml(formatSharedAreas(relationship)) : EMPTY_VALUE}</td>
  </tr>`;
}

function renderContributorCell(
  contributor: ContributorIdentity,
  isCurrentContributor: boolean,
): string {
  const contributorName = escapeHtml(contributor.name);
  const contributorMeta =
    contributor.email && contributor.email !== contributor.name
      ? `<div class="contributor-meta">${escapeHtml(contributor.email)}</div>`
      : "";
  const tags = isCurrentContributor
    ? '<div class="contributor-tags"><span class="tag">Current contributor</span></div>'
    : "";

  return `<div class="contributor-name">${contributorName}</div>${contributorMeta}${tags}`;
}

function formatSharedAreas(relationship: ContributorRelationship): string {
  if (!relationship.sampleSharedAreas.length) {
    return EMPTY_VALUE;
  }

  return relationship.sampleSharedAreas.join(", ");
}

function formatWorkspaceStatus(status: WorkspaceContributorRelationshipSnapshot["status"]): string {
  if (status === "no-current-contributor") {
    return "current contributor missing";
  }

  if (status === "no-history") {
    return "no history";
  }

  if (status === "not-git") {
    return "not git";
  }

  return status;
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

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLastActive(ageDays: number, nowMs: number): string {
  if (!Number.isFinite(ageDays)) {
    return EMPTY_VALUE;
  }

  const ageMs = Math.max(0, ageDays) * 24 * 60 * 60 * 1000;

  return formatRelativeTime(nowMs - ageMs, nowMs);
}

function formatRelativeTime(timestamp: number, now: number): string {
  const elapsedMs = Math.max(0, now - timestamp);

  if (elapsedMs < 60_000) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
