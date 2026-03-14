import type {
  RankingConfig,
  RankingContextConfig,
  RankingLexicalConfig,
  VisitTrackingConfig,
} from "./schema";

export type ScoringPresetId = "balanced" | "exact" | "recent" | "nearby" | "fuzzy";

interface ScoringPresetValues {
  readonly frecencyHalfLifeDays: number;
  readonly visits: VisitTrackingConfig;
  readonly ranking: RankingConfig;
}

export interface VisitTrackingConfigOverride {
  readonly implicitOpenWeight?: number;
  readonly explicitOpenWeight?: number;
  readonly editorDwellMs?: number;
  readonly duplicateVisitWindowMs?: number;
}

interface RankingLexicalConfigOverride {
  readonly basenameExactScore?: number;
  readonly pathExactScore?: number;
  readonly basenamePrefixScore?: number;
  readonly pathPrefixScore?: number;
  readonly basenameBoundaryScore?: number;
  readonly pathBoundaryScore?: number;
  readonly basenameSubstringScore?: number;
  readonly pathSubstringScore?: number;
  readonly basenameFuzzyBonus?: number;
  readonly pathFuzzyBonus?: number;
}

interface RankingContextConfigOverride {
  readonly frecencyQueryMultiplier?: number;
  readonly frecencyBrowseMultiplier?: number;
  readonly trackedQueryBoost?: number;
  readonly ignoredQueryPenalty?: number;
  readonly untrackedQueryPenalty?: number;
  readonly openQueryBoost?: number;
  readonly activeQueryBoost?: number;
  readonly sameDirectoryQueryBoost?: number;
  readonly sharedPrefixSegmentQueryBoost?: number;
  readonly sharedPrefixSingleQueryBoost?: number;
}

export interface RankingConfigOverride {
  readonly lexical?: RankingLexicalConfigOverride;
  readonly context?: RankingContextConfigOverride;
}

export interface ScoringPresetOverride {
  readonly frecencyHalfLifeDays?: number;
  readonly visits?: VisitTrackingConfigOverride;
  readonly ranking?: RankingConfigOverride;
}

interface ScoringPresetDefinition {
  readonly label: string;
  readonly description: string;
  readonly values: ScoringPresetValues;
}

const BALANCED_LEXICAL: RankingLexicalConfig = {
  basenameExactScore: 6100,
  pathExactScore: 5600,
  basenamePrefixScore: 5100,
  pathPrefixScore: 4550,
  basenameBoundaryScore: 4500,
  pathBoundaryScore: 3550,
  basenameSubstringScore: 2800,
  pathSubstringScore: 2300,
  basenameFuzzyBonus: 1450,
  pathFuzzyBonus: 700,
};

const BALANCED_CONTEXT: RankingContextConfig = {
  frecencyQueryMultiplier: 145,
  frecencyBrowseMultiplier: 180,
  trackedQueryBoost: 80,
  ignoredQueryPenalty: 1800,
  untrackedQueryPenalty: 1100,
  openQueryBoost: 120,
  activeQueryBoost: 80,
  sameDirectoryQueryBoost: 90,
  sharedPrefixSegmentQueryBoost: 28,
  sharedPrefixSingleQueryBoost: 16,
};

const DEFAULT_VISITS: VisitTrackingConfig = {
  implicitOpenWeight: 1,
  explicitOpenWeight: 2,
  editorDwellMs: 900,
  duplicateVisitWindowMs: 15000,
};

export const DEFAULT_SCORING_PRESET_ID: ScoringPresetId = "balanced";
export const DEFAULT_SCORING_CUSTOM_PRESET: ScoringPresetOverride = {};

const SCORING_PRESET_DEFINITIONS = {
  balanced: {
    label: "Balanced",
    description: "Prioritizes exact filename intent while keeping context boosts moderate.",
    values: {
      frecencyHalfLifeDays: 10,
      visits: DEFAULT_VISITS,
      ranking: {
        lexical: BALANCED_LEXICAL,
        context: BALANCED_CONTEXT,
      },
    },
  },
  exact: {
    label: "Exact",
    description:
      "Biases heavily toward exact and prefix matches with lighter contextual reranking.",
    values: {
      frecencyHalfLifeDays: 7,
      visits: DEFAULT_VISITS,
      ranking: {
        lexical: {
          basenameExactScore: 6900,
          pathExactScore: 6200,
          basenamePrefixScore: 5800,
          pathPrefixScore: 5000,
          basenameBoundaryScore: 4800,
          pathBoundaryScore: 3650,
          basenameSubstringScore: 2400,
          pathSubstringScore: 1900,
          basenameFuzzyBonus: 700,
          pathFuzzyBonus: 350,
        },
        context: {
          frecencyQueryMultiplier: 70,
          frecencyBrowseMultiplier: 110,
          trackedQueryBoost: 40,
          ignoredQueryPenalty: 1800,
          untrackedQueryPenalty: 1100,
          openQueryBoost: 80,
          activeQueryBoost: 60,
          sameDirectoryQueryBoost: 60,
          sharedPrefixSegmentQueryBoost: 18,
          sharedPrefixSingleQueryBoost: 8,
        },
      },
    },
  },
  recent: {
    label: "Recent",
    description: "Pushes recently and explicitly opened files higher, especially while browsing.",
    values: {
      frecencyHalfLifeDays: 21,
      visits: {
        implicitOpenWeight: 2,
        explicitOpenWeight: 4,
        editorDwellMs: 700,
        duplicateVisitWindowMs: 8000,
      },
      ranking: {
        lexical: BALANCED_LEXICAL,
        context: {
          frecencyQueryMultiplier: 220,
          frecencyBrowseMultiplier: 360,
          trackedQueryBoost: 80,
          ignoredQueryPenalty: 1800,
          untrackedQueryPenalty: 1100,
          openQueryBoost: 220,
          activeQueryBoost: 160,
          sameDirectoryQueryBoost: 110,
          sharedPrefixSegmentQueryBoost: 32,
          sharedPrefixSingleQueryBoost: 18,
        },
      },
    },
  },
  nearby: {
    label: "Nearby",
    description: "Favors files close to the active editor, package, and directory tree.",
    values: {
      frecencyHalfLifeDays: 10,
      visits: DEFAULT_VISITS,
      ranking: {
        lexical: {
          basenameExactScore: 6000,
          pathExactScore: 5700,
          basenamePrefixScore: 5000,
          pathPrefixScore: 4700,
          basenameBoundaryScore: 4400,
          pathBoundaryScore: 3850,
          basenameSubstringScore: 2700,
          pathSubstringScore: 2500,
          basenameFuzzyBonus: 1350,
          pathFuzzyBonus: 750,
        },
        context: {
          frecencyQueryMultiplier: 120,
          frecencyBrowseMultiplier: 190,
          trackedQueryBoost: 80,
          ignoredQueryPenalty: 1800,
          untrackedQueryPenalty: 1100,
          openQueryBoost: 180,
          activeQueryBoost: 140,
          sameDirectoryQueryBoost: 220,
          sharedPrefixSegmentQueryBoost: 95,
          sharedPrefixSingleQueryBoost: 55,
        },
      },
    },
  },
  fuzzy: {
    label: "Fuzzy",
    description: "Handles abbreviated and loose queries more aggressively than the other presets.",
    values: {
      frecencyHalfLifeDays: 12,
      visits: DEFAULT_VISITS,
      ranking: {
        lexical: {
          basenameExactScore: 5800,
          pathExactScore: 5400,
          basenamePrefixScore: 4700,
          pathPrefixScore: 4500,
          basenameBoundaryScore: 4200,
          pathBoundaryScore: 3600,
          basenameSubstringScore: 3400,
          pathSubstringScore: 3000,
          basenameFuzzyBonus: 2500,
          pathFuzzyBonus: 1500,
        },
        context: {
          frecencyQueryMultiplier: 100,
          frecencyBrowseMultiplier: 160,
          trackedQueryBoost: 70,
          ignoredQueryPenalty: 1800,
          untrackedQueryPenalty: 1100,
          openQueryBoost: 110,
          activeQueryBoost: 80,
          sameDirectoryQueryBoost: 80,
          sharedPrefixSegmentQueryBoost: 24,
          sharedPrefixSingleQueryBoost: 14,
        },
      },
    },
  },
} as const satisfies Record<ScoringPresetId, ScoringPresetDefinition>;

export function isScoringPresetId(value: string): value is ScoringPresetId {
  return value in SCORING_PRESET_DEFINITIONS;
}

export function getScoringPresetValues(preset: ScoringPresetId): ScoringPresetValues {
  return SCORING_PRESET_DEFINITIONS[preset].values;
}

export function resolveScoringPresetValues(
  preset: ScoringPresetId,
  customPreset: ScoringPresetOverride = DEFAULT_SCORING_CUSTOM_PRESET,
): ScoringPresetValues {
  const base = getScoringPresetValues(preset);

  if (!hasScoringPresetOverride(customPreset)) {
    return base;
  }

  return {
    frecencyHalfLifeDays: customPreset.frecencyHalfLifeDays ?? base.frecencyHalfLifeDays,
    visits: {
      ...base.visits,
      ...customPreset.visits,
    },
    ranking: {
      lexical: {
        ...base.ranking.lexical,
        ...customPreset.ranking?.lexical,
      },
      context: {
        ...base.ranking.context,
        ...customPreset.ranking?.context,
      },
    },
  };
}

export function hasScoringPresetOverride(
  customPreset: ScoringPresetOverride = DEFAULT_SCORING_CUSTOM_PRESET,
): boolean {
  return Object.keys(customPreset).length > 0;
}

export function parseScoringPresetOverrideInput(value: unknown): ScoringPresetOverride {
  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return DEFAULT_SCORING_CUSTOM_PRESET;
    }

    try {
      return sanitizeScoringPresetOverride(JSON.parse(trimmedValue));
    } catch {
      return DEFAULT_SCORING_CUSTOM_PRESET;
    }
  }

  return sanitizeScoringPresetOverride(value);
}

export function sanitizeScoringPresetOverride(value: unknown): ScoringPresetOverride {
  if (!isRecord(value)) {
    return DEFAULT_SCORING_CUSTOM_PRESET;
  }

  const frecencyHalfLifeDays = sanitizeNumber(value.frecencyHalfLifeDays, 1);
  const visits = sanitizeVisitTrackingConfigOverride(value.visits);
  const ranking = sanitizeRankingConfigOverride(value.ranking);

  return {
    ...(frecencyHalfLifeDays !== undefined ? { frecencyHalfLifeDays } : {}),
    ...(visits ? { visits } : {}),
    ...(ranking ? { ranking } : {}),
  };
}

function sanitizeVisitTrackingConfigOverride(
  value: unknown,
): VisitTrackingConfigOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const implicitOpenWeight = sanitizeNumber(value.implicitOpenWeight, 0);
  const explicitOpenWeight = sanitizeNumber(value.explicitOpenWeight, 0);
  const editorDwellMs = sanitizeInteger(value.editorDwellMs, 0);
  const duplicateVisitWindowMs = sanitizeInteger(value.duplicateVisitWindowMs, 0);

  return createObjectOrUndefined({
    implicitOpenWeight,
    explicitOpenWeight,
    editorDwellMs,
    duplicateVisitWindowMs,
  });
}

function sanitizeRankingConfigOverride(value: unknown): RankingConfigOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const lexical = sanitizeRankingLexicalConfigOverride(value.lexical);
  const context = sanitizeRankingContextConfigOverride(value.context);

  return createObjectOrUndefined({
    lexical,
    context,
  });
}

function sanitizeRankingLexicalConfigOverride(
  value: unknown,
): RankingLexicalConfigOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return createObjectOrUndefined({
    basenameExactScore: sanitizeNumber(value.basenameExactScore, 0),
    pathExactScore: sanitizeNumber(value.pathExactScore, 0),
    basenamePrefixScore: sanitizeNumber(value.basenamePrefixScore, 0),
    pathPrefixScore: sanitizeNumber(value.pathPrefixScore, 0),
    basenameBoundaryScore: sanitizeNumber(value.basenameBoundaryScore, 0),
    pathBoundaryScore: sanitizeNumber(value.pathBoundaryScore, 0),
    basenameSubstringScore: sanitizeNumber(value.basenameSubstringScore, 0),
    pathSubstringScore: sanitizeNumber(value.pathSubstringScore, 0),
    basenameFuzzyBonus: sanitizeNumber(value.basenameFuzzyBonus, 0),
    pathFuzzyBonus: sanitizeNumber(value.pathFuzzyBonus, 0),
  });
}

function sanitizeRankingContextConfigOverride(
  value: unknown,
): RankingContextConfigOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return createObjectOrUndefined({
    frecencyQueryMultiplier: sanitizeNumber(value.frecencyQueryMultiplier, 0),
    frecencyBrowseMultiplier: sanitizeNumber(value.frecencyBrowseMultiplier, 0),
    trackedQueryBoost: sanitizeNumber(value.trackedQueryBoost, 0),
    ignoredQueryPenalty: sanitizeNumber(value.ignoredQueryPenalty, 0),
    untrackedQueryPenalty: sanitizeNumber(value.untrackedQueryPenalty, 0),
    openQueryBoost: sanitizeNumber(value.openQueryBoost, 0),
    activeQueryBoost: sanitizeNumber(value.activeQueryBoost, 0),
    sameDirectoryQueryBoost: sanitizeNumber(value.sameDirectoryQueryBoost, 0),
    sharedPrefixSegmentQueryBoost: sanitizeNumber(value.sharedPrefixSegmentQueryBoost, 0),
    sharedPrefixSingleQueryBoost: sanitizeNumber(value.sharedPrefixSingleQueryBoost, 0),
  });
}

function sanitizeInteger(value: unknown, minimum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(minimum, Math.round(value));
}

function sanitizeNumber(value: unknown, minimum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(minimum, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createObjectOrUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);

  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}
