import * as vscode from "vscode";
import {
  DEFAULT_BETTER_GO_TO_FILE_CONFIG,
  type BetterGoToFileConfig,
  type GitignoredVisibility,
} from "./schema";

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

  return {
    picker: {
      showScores: readBoolean(configuration, "picker.showScores", defaults.picker.showScores),
      maxVisibleResults: readInteger(
        configuration,
        "picker.maxVisibleResults",
        defaults.picker.maxVisibleResults,
        1,
      ),
      description: {
        pathTailSegments: readInteger(
          configuration,
          "picker.description.pathTailSegments",
          defaults.picker.description.pathTailSegments,
          1,
        ),
        collapsedTailSegments: readInteger(
          configuration,
          "picker.description.collapsedTailSegments",
          defaults.picker.description.collapsedTailSegments,
          1,
        ),
        queryContextRadius: readInteger(
          configuration,
          "picker.description.queryContextRadius",
          defaults.picker.description.queryContextRadius,
          0,
        ),
        maxRowWidthUnits: readNumber(
          configuration,
          "picker.description.maxRowWidthUnits",
          defaults.picker.description.maxRowWidthUnits,
          1,
        ),
        labelPaddingWidthUnits: readNumber(
          configuration,
          "picker.description.labelPaddingWidthUnits",
          defaults.picker.description.labelPaddingWidthUnits,
          0,
        ),
        minDescriptionWidthUnits: readNumber(
          configuration,
          "picker.description.minDescriptionWidthUnits",
          defaults.picker.description.minDescriptionWidthUnits,
          1,
        ),
      },
    },
    gitignored: {
      visibility: readGitignoredVisibility(
        configuration,
        "gitignored.visibility",
        defaults.gitignored.visibility,
      ),
      auto: {
        minQueryLength: readInteger(
          configuration,
          "gitignored.auto.minQueryLength",
          defaults.gitignored.auto.minQueryLength,
          1,
        ),
        minTokenCount: readInteger(
          configuration,
          "gitignored.auto.minTokenCount",
          defaults.gitignored.auto.minTokenCount,
          1,
        ),
        revealOnPathSeparator: readBoolean(
          configuration,
          "gitignored.auto.revealOnPathSeparator",
          defaults.gitignored.auto.revealOnPathSeparator,
        ),
      },
    },
    workspaceIndex: {
      fileGlob: readNonEmptyString(
        configuration,
        "workspaceIndex.fileGlob",
        defaults.workspaceIndex.fileGlob,
      ),
      excludedDirectories: readStringArray(
        configuration,
        "workspaceIndex.excludedDirectories",
        defaults.workspaceIndex.excludedDirectories,
      ),
      maxFileCount: readInteger(
        configuration,
        "workspaceIndex.maxFileCount",
        defaults.workspaceIndex.maxFileCount,
        1,
      ),
    },
    frecency: {
      halfLifeMs:
        readNumber(
          configuration,
          "frecency.halfLifeDays",
          defaults.frecency.halfLifeMs / DAY_MS,
          1,
        ) * DAY_MS,
      flushDelayMs: readInteger(
        configuration,
        "frecency.flushDelayMs",
        defaults.frecency.flushDelayMs,
        0,
      ),
      maxRecords: readInteger(
        configuration,
        "frecency.maxRecords",
        defaults.frecency.maxRecords,
        1,
      ),
    },
    visits: {
      implicitOpenWeight: readNumber(
        configuration,
        "visits.implicitOpenWeight",
        defaults.visits.implicitOpenWeight,
        0,
      ),
      explicitOpenWeight: readNumber(
        configuration,
        "visits.explicitOpenWeight",
        defaults.visits.explicitOpenWeight,
        0,
      ),
      editorDwellMs: readInteger(
        configuration,
        "visits.editorDwellMs",
        defaults.visits.editorDwellMs,
        0,
      ),
      duplicateVisitWindowMs: readInteger(
        configuration,
        "visits.duplicateVisitWindowMs",
        defaults.visits.duplicateVisitWindowMs,
        0,
      ),
    },
    git: {
      refreshDebounceMs: readInteger(
        configuration,
        "git.refreshDebounceMs",
        defaults.git.refreshDebounceMs,
        0,
      ),
    },
    ranking: {
      lexical: {
        basenameExactScore: readNumber(
          configuration,
          "ranking.lexical.basenameExactScore",
          defaults.ranking.lexical.basenameExactScore,
          0,
        ),
        pathExactScore: readNumber(
          configuration,
          "ranking.lexical.pathExactScore",
          defaults.ranking.lexical.pathExactScore,
          0,
        ),
        basenamePrefixScore: readNumber(
          configuration,
          "ranking.lexical.basenamePrefixScore",
          defaults.ranking.lexical.basenamePrefixScore,
          0,
        ),
        pathPrefixScore: readNumber(
          configuration,
          "ranking.lexical.pathPrefixScore",
          defaults.ranking.lexical.pathPrefixScore,
          0,
        ),
        basenameBoundaryScore: readNumber(
          configuration,
          "ranking.lexical.basenameBoundaryScore",
          defaults.ranking.lexical.basenameBoundaryScore,
          0,
        ),
        pathBoundaryScore: readNumber(
          configuration,
          "ranking.lexical.pathBoundaryScore",
          defaults.ranking.lexical.pathBoundaryScore,
          0,
        ),
        basenameSubstringScore: readNumber(
          configuration,
          "ranking.lexical.basenameSubstringScore",
          defaults.ranking.lexical.basenameSubstringScore,
          0,
        ),
        pathSubstringScore: readNumber(
          configuration,
          "ranking.lexical.pathSubstringScore",
          defaults.ranking.lexical.pathSubstringScore,
          0,
        ),
        basenameFuzzyBonus: readNumber(
          configuration,
          "ranking.lexical.basenameFuzzyBonus",
          defaults.ranking.lexical.basenameFuzzyBonus,
          0,
        ),
        pathFuzzyBonus: readNumber(
          configuration,
          "ranking.lexical.pathFuzzyBonus",
          defaults.ranking.lexical.pathFuzzyBonus,
          0,
        ),
      },
      context: {
        frecencyQueryMultiplier: readNumber(
          configuration,
          "ranking.context.frecencyQueryMultiplier",
          defaults.ranking.context.frecencyQueryMultiplier,
          0,
        ),
        frecencyBrowseMultiplier: readNumber(
          configuration,
          "ranking.context.frecencyBrowseMultiplier",
          defaults.ranking.context.frecencyBrowseMultiplier,
          0,
        ),
        trackedQueryBoost: readNumber(
          configuration,
          "ranking.context.trackedQueryBoost",
          defaults.ranking.context.trackedQueryBoost,
          0,
        ),
        trackedBrowseBoost: readNumber(
          configuration,
          "ranking.context.trackedBrowseBoost",
          defaults.ranking.context.trackedBrowseBoost,
          0,
        ),
        ignoredQueryPenalty: readNumber(
          configuration,
          "ranking.context.ignoredQueryPenalty",
          defaults.ranking.context.ignoredQueryPenalty,
          0,
        ),
        ignoredBrowsePenalty: readNumber(
          configuration,
          "ranking.context.ignoredBrowsePenalty",
          defaults.ranking.context.ignoredBrowsePenalty,
          0,
        ),
        untrackedQueryPenalty: readNumber(
          configuration,
          "ranking.context.untrackedQueryPenalty",
          defaults.ranking.context.untrackedQueryPenalty,
          0,
        ),
        untrackedBrowsePenalty: readNumber(
          configuration,
          "ranking.context.untrackedBrowsePenalty",
          defaults.ranking.context.untrackedBrowsePenalty,
          0,
        ),
        openQueryBoost: readNumber(
          configuration,
          "ranking.context.openQueryBoost",
          defaults.ranking.context.openQueryBoost,
          0,
        ),
        openBrowseBoost: readNumber(
          configuration,
          "ranking.context.openBrowseBoost",
          defaults.ranking.context.openBrowseBoost,
          0,
        ),
        activeQueryBoost: readNumber(
          configuration,
          "ranking.context.activeQueryBoost",
          defaults.ranking.context.activeQueryBoost,
          0,
        ),
        activeBrowseBoost: readNumber(
          configuration,
          "ranking.context.activeBrowseBoost",
          defaults.ranking.context.activeBrowseBoost,
          0,
        ),
        sameDirectoryQueryBoost: readNumber(
          configuration,
          "ranking.context.sameDirectoryQueryBoost",
          defaults.ranking.context.sameDirectoryQueryBoost,
          0,
        ),
        sameDirectoryBrowseBoost: readNumber(
          configuration,
          "ranking.context.sameDirectoryBrowseBoost",
          defaults.ranking.context.sameDirectoryBrowseBoost,
          0,
        ),
        sharedPrefixSegmentQueryBoost: readNumber(
          configuration,
          "ranking.context.sharedPrefixSegmentQueryBoost",
          defaults.ranking.context.sharedPrefixSegmentQueryBoost,
          0,
        ),
        sharedPrefixSegmentBrowseBoost: readNumber(
          configuration,
          "ranking.context.sharedPrefixSegmentBrowseBoost",
          defaults.ranking.context.sharedPrefixSegmentBrowseBoost,
          0,
        ),
        sharedPrefixSingleQueryBoost: readNumber(
          configuration,
          "ranking.context.sharedPrefixSingleQueryBoost",
          defaults.ranking.context.sharedPrefixSingleQueryBoost,
          0,
        ),
        sharedPrefixSingleBrowseBoost: readNumber(
          configuration,
          "ranking.context.sharedPrefixSingleBrowseBoost",
          defaults.ranking.context.sharedPrefixSingleBrowseBoost,
          0,
        ),
      },
    },
    diagnostics: {
      iconSampleCount: readInteger(
        configuration,
        "diagnostics.iconSampleCount",
        defaults.diagnostics.iconSampleCount,
        1,
      ),
    },
  };
}

function readBoolean(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
): boolean {
  return configuration.get<boolean>(key, fallback);
}

function readNonEmptyString(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string,
): string {
  const value = configuration.get<string>(key, fallback)?.trim();

  return value || fallback;
}

function readInteger(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = configuration.get<number>(key, fallback);

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.round(value));
}

function readNumber(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = configuration.get<number>(key, fallback);

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, value);
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
