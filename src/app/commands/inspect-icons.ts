import * as vscode from "vscode";
import type { FileEntry } from "../../workspace";
import { loadFileIconResolver } from "../../icons";
import { SearchRuntime } from "../../search";

export async function inspectIcons(
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

    for (const entry of pickIconSamples(entries, runtime.getConfig().diagnostics.iconSampleCount)) {
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

function pickIconSamples(entries: readonly FileEntry[], targetCount: number): FileEntry[] {
  const preferredBasenames = new Set([".env", ".gitignore"]);
  const preferredExtensions = [".tsx", ".json", ".ts", ".js"];
  const samples: FileEntry[] = [];

  for (const entry of entries) {
    if (samples.length >= targetCount) {
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

  if (samples.length < targetCount) {
    for (const entry of entries) {
      if (samples.length >= targetCount) {
        break;
      }

      if (!samples.includes(entry)) {
        samples.push(entry);
      }
    }
  }

  return samples;
}
