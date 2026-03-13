import {
  DEFAULT_SCORING_CUSTOM_PRESET,
  DEFAULT_SCORING_PRESET_ID,
  getScoringPresetValues,
  type ScoringPresetId,
  type ScoringPresetOverride,
} from "./scoring-presets";

export type GitignoredVisibility = "show" | "auto" | "hide";

export interface PickerDescriptionConfig {
  readonly pathTailSegments: number;
  readonly collapsedTailSegments: number;
  readonly queryContextRadius: number;
  readonly maxRowWidthUnits: number;
  readonly labelPaddingWidthUnits: number;
  readonly minDescriptionWidthUnits: number;
}

export interface PickerConfig {
  readonly showScores: boolean;
  readonly maxVisibleResults: number;
  readonly description: PickerDescriptionConfig;
}

export interface GitignoredAutoConfig {
  readonly minQueryLength: number;
  readonly minTokenCount: number;
  readonly revealOnPathSeparator: boolean;
}

export interface GitignoredConfig {
  readonly visibility: GitignoredVisibility;
  readonly auto: GitignoredAutoConfig;
}

export interface WorkspaceIndexConfig {
  readonly fileGlob: string;
  readonly excludedDirectories: readonly string[];
  readonly maxFileCount: number;
}

export interface FrecencyConfig {
  readonly halfLifeMs: number;
  readonly flushDelayMs: number;
  readonly maxRecords: number;
}

export interface VisitTrackingConfig {
  readonly implicitOpenWeight: number;
  readonly explicitOpenWeight: number;
  readonly editorDwellMs: number;
  readonly duplicateVisitWindowMs: number;
}

export interface GitConfig {
  readonly refreshDebounceMs: number;
}

export interface RankingLexicalConfig {
  readonly basenameExactScore: number;
  readonly pathExactScore: number;
  readonly basenamePrefixScore: number;
  readonly pathPrefixScore: number;
  readonly basenameBoundaryScore: number;
  readonly pathBoundaryScore: number;
  readonly basenameSubstringScore: number;
  readonly pathSubstringScore: number;
  readonly basenameFuzzyBonus: number;
  readonly pathFuzzyBonus: number;
}

export interface RankingContextConfig {
  readonly frecencyQueryMultiplier: number;
  readonly frecencyBrowseMultiplier: number;
  readonly trackedQueryBoost: number;
  readonly trackedBrowseBoost: number;
  readonly ignoredQueryPenalty: number;
  readonly ignoredBrowsePenalty: number;
  readonly untrackedQueryPenalty: number;
  readonly untrackedBrowsePenalty: number;
  readonly openQueryBoost: number;
  readonly openBrowseBoost: number;
  readonly activeQueryBoost: number;
  readonly activeBrowseBoost: number;
  readonly sameDirectoryQueryBoost: number;
  readonly sameDirectoryBrowseBoost: number;
  readonly sharedPrefixSegmentQueryBoost: number;
  readonly sharedPrefixSegmentBrowseBoost: number;
  readonly sharedPrefixSingleQueryBoost: number;
  readonly sharedPrefixSingleBrowseBoost: number;
}

export interface RankingConfig {
  readonly lexical: RankingLexicalConfig;
  readonly context: RankingContextConfig;
}

export interface DiagnosticsConfig {
  readonly iconSampleCount: number;
}

export interface ScoringSettingsConfig {
  readonly preset: ScoringPresetId;
  readonly customPreset: ScoringPresetOverride;
}

export interface BetterGoToFileConfig {
  readonly picker: PickerConfig;
  readonly gitignored: GitignoredConfig;
  readonly workspaceIndex: WorkspaceIndexConfig;
  readonly scoring: ScoringSettingsConfig;
  readonly frecency: FrecencyConfig;
  readonly visits: VisitTrackingConfig;
  readonly git: GitConfig;
  readonly ranking: RankingConfig;
  readonly diagnostics: DiagnosticsConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCORING_VALUES = getScoringPresetValues(DEFAULT_SCORING_PRESET_ID);

export const DEFAULT_BETTER_GO_TO_FILE_CONFIG: BetterGoToFileConfig = {
  picker: {
    showScores: false,
    maxVisibleResults: 200,
    description: {
      pathTailSegments: 3,
      collapsedTailSegments: 2,
      queryContextRadius: 1,
      maxRowWidthUnits: 72,
      labelPaddingWidthUnits: 8,
      minDescriptionWidthUnits: 16,
    },
  },
  gitignored: {
    visibility: "auto",
    auto: {
      minQueryLength: 12,
      minTokenCount: 2,
      revealOnPathSeparator: true,
    },
  },
  workspaceIndex: {
    fileGlob: "**/*",
    excludedDirectories: [
      ".git",
      "node_modules",
      "dist",
      "out",
      ".next",
      ".nx",
      ".turbo",
      "coverage",
    ],
    maxFileCount: 0,
  },
  scoring: {
    preset: DEFAULT_SCORING_PRESET_ID,
    customPreset: DEFAULT_SCORING_CUSTOM_PRESET,
  },
  frecency: {
    halfLifeMs: DEFAULT_SCORING_VALUES.frecencyHalfLifeDays * DAY_MS,
    flushDelayMs: 1500,
    maxRecords: 20000,
  },
  visits: DEFAULT_SCORING_VALUES.visits,
  git: {
    refreshDebounceMs: 500,
  },
  ranking: DEFAULT_SCORING_VALUES.ranking,
  diagnostics: {
    iconSampleCount: 6,
  },
};
