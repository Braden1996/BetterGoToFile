import * as vscode from "vscode";
import {
  DEFAULT_BETTER_GO_TO_FILE_CONFIG,
  type BetterGoToFileConfig,
  type GitignoredVisibility,
} from "./schema";
import {
  hasScoringPresetOverride,
  isScoringPresetId,
  parseScoringPresetOverrideInput,
  resolveScoringPresetValues,
} from "./scoring-presets";

const DAY_MS = 24 * 60 * 60 * 1000;

const BETTER_GO_TO_FILE_CONFIGURATION_SECTION = "betterGoToFile";

interface BetterGoToFileConfigChange {
  readonly previous: BetterGoToFileConfig;
  readonly current: BetterGoToFileConfig;
}

export class BetterGoToFileConfigStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<BetterGoToFileConfigChange>();
  private readonly configurationChangeDisposable: vscode.Disposable;
  private current = readBetterGoToFileConfig();

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(BETTER_GO_TO_FILE_CONFIGURATION_SECTION)) {
        return;
      }

      const previous = this.current;
      const current = readBetterGoToFileConfig();

      this.current = current;
      this.emitter.fire({ previous, current });
    });
  }

  get(): BetterGoToFileConfig {
    return this.current;
  }

  dispose(): void {
    this.configurationChangeDisposable.dispose();
    this.emitter.dispose();
  }
}

function readBetterGoToFileConfig(): BetterGoToFileConfig {
  const configuration = vscode.workspace.getConfiguration(BETTER_GO_TO_FILE_CONFIGURATION_SECTION);
  const defaults = DEFAULT_BETTER_GO_TO_FILE_CONFIG;
  const scoringPreset = readScoringPresetId(
    configuration,
    "scoring.preset",
    defaults.scoring.preset,
  );
  const customPreset = readScoringPresetOverride(configuration, "scoring.customPreset");
  const scoringValues = resolveScoringPresetValues(scoringPreset, customPreset);

  return {
    picker: defaults.picker,
    gitignored: {
      visibility: readGitignoredVisibility(
        configuration,
        "gitignored.visibility",
        defaults.gitignored.visibility,
      ),
      auto: defaults.gitignored.auto,
    },
    workspaceIndex: {
      fileGlob: defaults.workspaceIndex.fileGlob,
      excludedDirectories: readStringArray(
        configuration,
        "workspaceIndex.excludedDirectories",
        defaults.workspaceIndex.excludedDirectories,
      ),
      maxFileCount: defaults.workspaceIndex.maxFileCount,
    },
    scoring: {
      preset: scoringPreset,
      customPreset,
    },
    frecency: {
      halfLifeMs: scoringValues.frecencyHalfLifeDays * DAY_MS,
      flushDelayMs: defaults.frecency.flushDelayMs,
      maxRecords: defaults.frecency.maxRecords,
    },
    visits: scoringValues.visits,
    git: {
      refreshDebounceMs: defaults.git.refreshDebounceMs,
    },
    ranking: scoringValues.ranking,
    diagnostics: defaults.diagnostics,
  };
}

function readStringArray(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = configuration.get<readonly string[]>(key, fallback);

  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();

    if (trimmed) {
      normalized.add(trimmed);
    }
  }

  return normalized.size ? [...normalized] : fallback;
}

function readScoringPresetId(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: BetterGoToFileConfig["scoring"]["preset"],
): BetterGoToFileConfig["scoring"]["preset"] {
  const value = configuration.get<string>(key, fallback);

  return typeof value === "string" && isScoringPresetId(value) ? value : fallback;
}

function readScoringPresetOverride(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): BetterGoToFileConfig["scoring"]["customPreset"] {
  return parseScoringPresetOverrideInput(configuration.get<unknown>(key));
}

export function isUsingCustomScoring(config: BetterGoToFileConfig): boolean {
  return hasScoringPresetOverride(config.scoring.customPreset);
}

function readGitignoredVisibility(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: GitignoredVisibility,
): GitignoredVisibility {
  const value = configuration.get<GitignoredVisibility>(key, fallback);

  if (value === "show" || value === "auto" || value === "hide") {
    return value;
  }

  return fallback;
}
