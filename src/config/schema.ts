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

export interface BetterGoToFileConfig {
  readonly picker: PickerConfig;
  readonly gitignored: GitignoredConfig;
  readonly workspaceIndex: WorkspaceIndexConfig;
  readonly frecency: FrecencyConfig;
  readonly visits: VisitTrackingConfig;
  readonly git: GitConfig;
  readonly ranking: RankingConfig;
  readonly diagnostics: DiagnosticsConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
      minQueryLength: 5,
      minTokenCount: 2,
      revealOnPathSeparator: true,
    },
  },
  workspaceIndex: {
    fileGlob: "**/*",
    excludedDirectories: [".git", "node_modules", "dist", "out", ".next", ".turbo", "coverage"],
    maxFileCount: 50000,
  },
  frecency: {
    halfLifeMs: 14 * DAY_MS,
    flushDelayMs: 1500,
    maxRecords: 20000,
  },
  visits: {
    implicitOpenWeight: 1,
    explicitOpenWeight: 2,
    editorDwellMs: 900,
    duplicateVisitWindowMs: 15000,
  },
  git: {
    refreshDebounceMs: 500,
  },
  ranking: {
    lexical: {
      basenameExactScore: 5600,
      pathExactScore: 5200,
      basenamePrefixScore: 4700,
      pathPrefixScore: 4300,
      basenameBoundaryScore: 3900,
      pathBoundaryScore: 3200,
      basenameSubstringScore: 3000,
      pathSubstringScore: 2500,
      basenameFuzzyBonus: 1800,
      pathFuzzyBonus: 900,
    },
    context: {
      frecencyQueryMultiplier: 140,
      frecencyBrowseMultiplier: 240,
      trackedQueryBoost: 120,
      trackedBrowseBoost: 240,
      ignoredQueryPenalty: 1800,
      ignoredBrowsePenalty: 3000,
      untrackedQueryPenalty: 1100,
      untrackedBrowsePenalty: 2200,
      openQueryBoost: 170,
      openBrowseBoost: 320,
      activeQueryBoost: 120,
      activeBrowseBoost: 260,
      sameDirectoryQueryBoost: 110,
      sameDirectoryBrowseBoost: 210,
      sharedPrefixSegmentQueryBoost: 40,
      sharedPrefixSegmentBrowseBoost: 70,
      sharedPrefixSingleQueryBoost: 24,
      sharedPrefixSingleBrowseBoost: 44,
    },
  },
  diagnostics: {
    iconSampleCount: 6,
  },
};
