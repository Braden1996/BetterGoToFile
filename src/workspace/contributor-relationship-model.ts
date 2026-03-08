import * as path from "node:path";
import { collectPackageRootDirectories, findNearestPackageRoot } from "./package-root";

const ACTIVITY_FULL_WEIGHT_DAYS = 30;
const ACTIVITY_SLOPE_DAYS = 120;
const AREA_FAST_HALF_LIFE_DAYS = 30;
const AREA_SLOW_HALF_LIFE_DAYS = 365;
const BOT_CONTRIBUTOR_PATTERN =
  /\b(?:dependabot|renovate|github-actions|semantic-release|buildkite|circleci|bot)\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RELATIONSHIP_LIMIT = 10;
const DEFAULT_SAMPLE_SIZE = 3;
const FILE_FAST_HALF_LIFE_DAYS = 14;
const FILE_LINEAGE_PREFIX = "lineage:";
const FILE_SLOW_HALF_LIFE_DAYS = 120;
const GENERATED_PATH_PATTERN =
  /(?:^|\/)(?:dist|build|coverage|generated|gen|vendor|storybook-static)(?:\/|$)|(?:^|\/)[^/]+\.(?:lock|min\.js|snap)$/i;
const MAX_RELEVANT_FILES_PER_COMMIT = 512;
const MEANINGFUL_AREA_PREFIX_COUNT = 2;
const MECHANICAL_MESSAGE_PATTERN =
  /\b(?:lint|format|prettier|eslint|codemod|mechanical|autofix|snapshot|lockfile|line endings?|line-ending normalization)\b/i;
const RECENT_COMMIT_WINDOW_DAYS = 30;
const RELATIONSHIP_FAST_WEIGHT = 0.7;
const RELATIONSHIP_SLOW_WEIGHT = 0.3;
const SEARCH_TEAMMATE_AREA_BLEND = 0.35;
const SEARCH_TEAMMATE_LIMIT = 10;

export interface ContributorIdentity {
  readonly key: string;
  readonly name: string;
  readonly email?: string;
}

export interface ContributorTouchedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly addedLineCount?: number;
  readonly deletedLineCount?: number;
  readonly status?: string;
}

export interface ContributorTouch {
  readonly contributor: ContributorIdentity;
  readonly touchedPaths: readonly string[];
  readonly files?: readonly ContributorTouchedFile[];
  readonly committedAtMs?: number;
  readonly message?: string;
}

export interface ContributorSummary {
  readonly contributor: ContributorIdentity;
  readonly touchedFileCount: number;
  readonly touchedCommitCount: number;
  readonly recentCommitCount: number;
  readonly lastCommitAgeDays: number;
  readonly areaFastWeight: number;
  readonly areaSlowWeight: number;
  readonly fileFastWeight: number;
  readonly fileSlowWeight: number;
  readonly broadness: number;
}

export interface ContributorSelector {
  readonly name?: string;
  readonly email?: string;
}

export interface ContributorRelationship {
  readonly contributor: ContributorIdentity;
  readonly relationshipScore: number;
  readonly activityFactor: number;
  readonly fastSimilarity: number;
  readonly slowSimilarity: number;
  readonly broadnessPenalty: number;
  readonly contributorBroadness: number;
  readonly sharedAreaCount: number;
  readonly contributorFileCount: number;
  readonly contributorCommitCount: number;
  readonly contributorRecentCommitCount: number;
  readonly contributorLastCommitAgeDays: number;
  readonly sampleSharedAreas: readonly string[];
}

interface ContributorRelationshipGraph {
  readonly contributors: readonly ContributorSummary[];
  readonly contributorFiles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly contributorCommitCounts: ReadonlyMap<string, number>;
  readonly contributorRecentCommitCounts: ReadonlyMap<string, number>;
  readonly contributorLastCommitAgeDays: ReadonlyMap<string, number>;
  readonly contributorAreaFastWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorAreaSlowWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorFileFastWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorFileSlowWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorAreaFastNorms: ReadonlyMap<string, number>;
  readonly contributorAreaSlowNorms: ReadonlyMap<string, number>;
  readonly contributorBroadnesses: ReadonlyMap<string, number>;
  readonly currentPathToLineageKey: ReadonlyMap<string, string>;
  readonly identitiesByKey: ReadonlyMap<string, ContributorIdentity>;
  readonly currentContributorKey?: string;
}

export interface ContributorSearchProfile {
  readonly contributorKey: string;
  readonly currentPathToLineageKey: ReadonlyMap<string, string>;
  readonly fileWeights: ReadonlyMap<string, number>;
  readonly ownerShares: ReadonlyMap<string, number>;
  readonly teammateCount: number;
  readonly teamAreaWeights: ReadonlyMap<string, number>;
  readonly teamFileWeights: ReadonlyMap<string, number>;
}

interface ContributorFilePrior {
  readonly areaPrior: number;
  readonly filePrior: number;
  readonly ownerPrior: number;
  readonly teamPrior: number;
  readonly total: number;
}

interface BuildContributorRelationshipGraphOptions {
  readonly currentContributor?: ContributorSelector;
  readonly nowMs?: number;
  readonly trackedPaths?: ReadonlySet<string>;
}

interface BuildContributorSearchProfileOptions {
  readonly teammateAreaBlend?: number;
  readonly teammateLimit?: number;
}

interface RankContributorRelationshipOptions {
  readonly limit?: number;
  readonly sampleSize?: number;
}

interface NormalizedContributorFile {
  readonly areaPrefixes: readonly string[];
  readonly currentPath: string;
  readonly lineageKey: string;
  readonly magnitude: number;
}

interface RawTouchedFile {
  readonly addedLineCount?: number;
  readonly deletedLineCount?: number;
  readonly path: string;
  readonly previousPath?: string;
  readonly status?: string;
}

interface CommitSignals {
  readonly quality: number;
  readonly spreadPenalty: number;
}

interface ContributorAliasResolution {
  readonly canonicalByRawKey: ReadonlyMap<string, ContributorIdentity>;
  readonly rawKeysByRawKey: ReadonlyMap<string, ReadonlySet<string>>;
}

interface NormalizedTouchFiles {
  readonly files: readonly NormalizedContributorFile[];
  readonly relevantRawTouchedFiles: readonly RawTouchedFile[];
}

interface RelationshipAreaEntry {
  readonly areaPrefix: string;
  readonly combinedWeight: number;
}

interface SelfContributorResolution {
  readonly contributor?: ContributorIdentity;
  readonly rawKeys: ReadonlySet<string>;
}

export function createContributorIdentity(name: string, email?: string): ContributorIdentity {
  const normalizedName = normalizeContributorName(name);
  const normalizedEmail = normalizeContributorEmail(email);
  const displayName = normalizedName || normalizedEmail || "Unknown Contributor";

  return {
    key: normalizedEmail ? `email:${normalizedEmail}` : `name:${displayName.toLowerCase()}`,
    name: displayName,
    email: normalizedEmail,
  };
}

export function formatContributorIdentity(contributor: ContributorIdentity): string {
  if (contributor.email && contributor.name !== contributor.email) {
    return `${contributor.name} <${contributor.email}>`;
  }

  return contributor.name;
}

export function buildContributorRelationshipGraph(
  touches: readonly ContributorTouch[],
  options: BuildContributorRelationshipGraphOptions = {},
): ContributorRelationshipGraph {
  const nowMs = options.nowMs ?? Date.now();
  const trackedPaths = options.trackedPaths;
  const packageRootDirectories = collectPackageRootsForGraph(touches, trackedPaths);
  const rawIdentitiesByKey = new Map<string, ContributorIdentity>();
  const rawTouchCountsByKey = new Map<string, number>();

  for (const touch of touches) {
    rawIdentitiesByKey.set(touch.contributor.key, touch.contributor);
    rawTouchCountsByKey.set(
      touch.contributor.key,
      (rawTouchCountsByKey.get(touch.contributor.key) ?? 0) + 1,
    );
  }

  const aliasResolution = buildContributorAliasResolution(rawIdentitiesByKey, rawTouchCountsByKey);
  const selfContributor = resolveSelfContributor(
    rawIdentitiesByKey,
    aliasResolution,
    options.currentContributor,
  );
  const contributorFiles = new Map<string, Set<string>>();
  const contributorCommitCounts = new Map<string, number>();
  const contributorRecentCommitCounts = new Map<string, number>();
  const contributorLastCommitAgeDays = new Map<string, number>();
  const identitiesByKey = new Map<string, ContributorIdentity>();
  const lineageCurrentPaths = new Map<string, string>();
  const noiseTotals = new Map<string, number>();
  const noiseWeights = new Map<string, number>();
  const contributorAreaFastWeights = new Map<string, Map<string, number>>();
  const contributorAreaSlowWeights = new Map<string, Map<string, number>>();
  const contributorFileFastWeights = new Map<string, Map<string, number>>();
  const contributorFileSlowWeights = new Map<string, Map<string, number>>();
  const pathToLineageKey = new Map<string, string>();
  const orderedTouches = areTouchesInReverseChronologicalOrder(touches)
    ? touches
    : [...touches].sort((left, right) => (right.committedAtMs ?? 0) - (left.committedAtMs ?? 0));

  for (const touch of orderedTouches) {
    if (shouldIgnoreContributor(touch.contributor, selfContributor.rawKeys)) {
      continue;
    }

    const contributor = canonicalizeContributor(
      touch.contributor,
      aliasResolution,
      selfContributor.rawKeys,
      selfContributor.contributor,
    );
    const rawTouchedFiles = collectRawTouchedFiles(touch);

    if (!rawTouchedFiles.length) {
      continue;
    }

    const ageDays = getAgeDays(nowMs, touch.committedAtMs);
    const normalizedTouchFiles = normalizeTouchedFiles(
      rawTouchedFiles,
      trackedPaths,
      pathToLineageKey,
      lineageCurrentPaths,
      packageRootDirectories,
    );
    const normalizedFiles = normalizedTouchFiles.files;

    if (
      !normalizedFiles.length ||
      normalizedTouchFiles.relevantRawTouchedFiles.length > MAX_RELEVANT_FILES_PER_COMMIT
    ) {
      continue;
    }

    const commitSignals = computeCommitSignals(
      normalizedTouchFiles.relevantRawTouchedFiles,
      packageRootDirectories,
      touch.message,
    );
    const breadthPenalty = computeBreadthPenalty(
      normalizedTouchFiles.relevantRawTouchedFiles.length,
    );

    identitiesByKey.set(contributor.key, contributor);
    contributorCommitCounts.set(
      contributor.key,
      (contributorCommitCounts.get(contributor.key) ?? 0) + 1,
    );
    contributorLastCommitAgeDays.set(
      contributor.key,
      Math.min(
        contributorLastCommitAgeDays.get(contributor.key) ?? Number.POSITIVE_INFINITY,
        ageDays,
      ),
    );

    if (ageDays <= RECENT_COMMIT_WINDOW_DAYS) {
      contributorRecentCommitCounts.set(
        contributor.key,
        (contributorRecentCommitCounts.get(contributor.key) ?? 0) + 1,
      );
    }

    let filesForContributor = contributorFiles.get(contributor.key);

    if (!filesForContributor) {
      filesForContributor = new Set<string>();
      contributorFiles.set(contributor.key, filesForContributor);
    }

    for (const file of normalizedFiles) {
      filesForContributor.add(file.currentPath);
    }

    const noiseWeight = decayForHalfLife(ageDays, AREA_FAST_HALF_LIFE_DAYS);
    const areaFastDecay = noiseWeight;
    const areaSlowDecay = decayForHalfLife(ageDays, AREA_SLOW_HALF_LIFE_DAYS);
    const fileFastDecay = decayForHalfLife(ageDays, FILE_FAST_HALF_LIFE_DAYS);
    const fileSlowDecay = decayForHalfLife(ageDays, FILE_SLOW_HALF_LIFE_DAYS);

    noiseTotals.set(
      contributor.key,
      (noiseTotals.get(contributor.key) ?? 0) + (1 - commitSignals.quality) * noiseWeight,
    );
    noiseWeights.set(contributor.key, (noiseWeights.get(contributor.key) ?? 0) + noiseWeight);

    for (const file of normalizedFiles) {
      const baseEventWeight =
        commitSignals.quality * file.magnitude * breadthPenalty * commitSignals.spreadPenalty;

      if (baseEventWeight <= 0) {
        continue;
      }

      const areaAllocations = buildAreaPrefixAllocations(file.areaPrefixes);

      if (areaFastDecay > 0) {
        for (const allocation of areaAllocations) {
          addContributorEdgeWeight(
            contributorAreaFastWeights,
            contributor.key,
            allocation.key,
            baseEventWeight * areaFastDecay * allocation.weight,
          );
        }
      }

      if (areaSlowDecay > 0) {
        for (const allocation of areaAllocations) {
          addContributorEdgeWeight(
            contributorAreaSlowWeights,
            contributor.key,
            allocation.key,
            baseEventWeight * areaSlowDecay * allocation.weight,
          );
        }
      }

      addContributorEdgeWeight(
        contributorFileFastWeights,
        contributor.key,
        file.lineageKey,
        baseEventWeight * fileFastDecay,
      );
      addContributorEdgeWeight(
        contributorFileSlowWeights,
        contributor.key,
        file.lineageKey,
        baseEventWeight * fileSlowDecay,
      );
    }
  }

  const contributorAreaFastNorms = computeVectorNorms(contributorAreaFastWeights);
  const contributorAreaSlowNorms = computeVectorNorms(contributorAreaSlowWeights);
  const contributorBroadnesses = computeContributorBroadnesses(
    contributorAreaSlowWeights,
    noiseTotals,
    noiseWeights,
  );
  const contributors = [...identitiesByKey.values()]
    .map((contributor) => ({
      contributor,
      touchedFileCount: contributorFiles.get(contributor.key)?.size ?? 0,
      touchedCommitCount: contributorCommitCounts.get(contributor.key) ?? 0,
      recentCommitCount: contributorRecentCommitCounts.get(contributor.key) ?? 0,
      lastCommitAgeDays:
        contributorLastCommitAgeDays.get(contributor.key) ?? Number.POSITIVE_INFINITY,
      areaFastWeight: sumWeightMap(contributorAreaFastWeights.get(contributor.key)),
      areaSlowWeight: sumWeightMap(contributorAreaSlowWeights.get(contributor.key)),
      fileFastWeight: sumWeightMap(contributorFileFastWeights.get(contributor.key)),
      fileSlowWeight: sumWeightMap(contributorFileSlowWeights.get(contributor.key)),
      broadness: contributorBroadnesses.get(contributor.key) ?? 0,
    }))
    .filter((summary) => summary.touchedCommitCount > 0)
    .sort(compareContributorSummaries);

  return {
    contributors,
    contributorFiles,
    contributorCommitCounts,
    contributorRecentCommitCounts,
    contributorLastCommitAgeDays,
    contributorAreaFastWeights,
    contributorAreaSlowWeights,
    contributorFileFastWeights,
    contributorFileSlowWeights,
    contributorAreaFastNorms,
    contributorAreaSlowNorms,
    contributorBroadnesses,
    currentPathToLineageKey: new Map(
      [...lineageCurrentPaths.entries()].map(([lineageKey, currentPath]) => [
        currentPath,
        lineageKey,
      ]),
    ),
    identitiesByKey,
    currentContributorKey: selfContributor.contributor?.key,
  };
}

export function buildContributorSearchProfile(
  graph: ContributorRelationshipGraph,
  contributorKey: string,
  options: BuildContributorSearchProfileOptions = {},
): ContributorSearchProfile | undefined {
  const fileWeights = getCombinedContributorWeights(
    graph.contributorFileFastWeights,
    graph.contributorFileSlowWeights,
    contributorKey,
  );
  const teamAreaWeights = getCombinedContributorWeights(
    graph.contributorAreaFastWeights,
    graph.contributorAreaSlowWeights,
    contributorKey,
  );

  if (!fileWeights.size || !teamAreaWeights.size) {
    return undefined;
  }

  const teammateLimit = options.teammateLimit ?? SEARCH_TEAMMATE_LIMIT;
  const teammateAreaBlend = options.teammateAreaBlend ?? SEARCH_TEAMMATE_AREA_BLEND;
  const teamFileWeights = new Map<string, number>();
  const relationships = rankContributorRelationships(graph, contributorKey, {
    limit: teammateLimit,
  });

  for (const relationship of relationships) {
    const similarity = relationship.relationshipScore;

    if (similarity <= 0) {
      continue;
    }

    addScaledWeights(
      teamAreaWeights,
      getCombinedContributorWeights(
        graph.contributorAreaFastWeights,
        graph.contributorAreaSlowWeights,
        relationship.contributor.key,
      ),
      teammateAreaBlend * similarity,
    );
    addScaledWeights(
      teamFileWeights,
      getCombinedContributorWeights(
        graph.contributorFileFastWeights,
        graph.contributorFileSlowWeights,
        relationship.contributor.key,
      ),
      similarity,
    );
  }

  const lineageTotals = collectCombinedLineageTotals(graph);
  const ownerShares = new Map<string, number>();

  for (const [lineageKey, weight] of fileWeights.entries()) {
    const totalWeight = lineageTotals.get(lineageKey) ?? 0;

    if (totalWeight > 0) {
      ownerShares.set(lineageKey, weight / totalWeight);
    }
  }

  return {
    contributorKey,
    currentPathToLineageKey: graph.currentPathToLineageKey,
    fileWeights,
    ownerShares,
    teammateCount: relationships.length,
    teamAreaWeights,
    teamFileWeights,
  };
}

export function scoreContributorFile(
  profile: ContributorSearchProfile,
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): ContributorFilePrior {
  const areaPrefixes = collectMeaningfulAreaPrefixes(filePath, packageRootDirectories);
  const areaAllocations = buildAreaPrefixAllocations(areaPrefixes);
  let areaPrior = 0;

  for (const allocation of areaAllocations) {
    areaPrior += allocation.weight * (profile.teamAreaWeights.get(allocation.key) ?? 0);
  }

  const lineageKey = profile.currentPathToLineageKey.get(filePath);
  const filePrior = lineageKey ? (profile.fileWeights.get(lineageKey) ?? 0) : 0;
  const teamPrior = lineageKey ? (profile.teamFileWeights.get(lineageKey) ?? 0) : 0;
  const ownerPrior = lineageKey ? (profile.ownerShares.get(lineageKey) ?? 0) : 0;

  return {
    areaPrior,
    filePrior,
    ownerPrior,
    teamPrior,
    total: 1.8 * areaPrior + 1.4 * filePrior + 1.0 * teamPrior + 0.8 * ownerPrior,
  };
}

export function rankContributorRelationships(
  graph: ContributorRelationshipGraph,
  contributorKey: string,
  options: RankContributorRelationshipOptions = {},
): readonly ContributorRelationship[] {
  const currentAreaFastWeights = graph.contributorAreaFastWeights.get(contributorKey);
  const currentAreaSlowWeights = graph.contributorAreaSlowWeights.get(contributorKey);
  const currentAreaFastNorm = graph.contributorAreaFastNorms.get(contributorKey) ?? 0;
  const currentAreaSlowNorm = graph.contributorAreaSlowNorms.get(contributorKey) ?? 0;
  const relationshipLimit = options.limit ?? DEFAULT_RELATIONSHIP_LIMIT;
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  if (
    !currentAreaFastWeights?.size ||
    !currentAreaSlowWeights?.size ||
    currentAreaFastNorm <= 0 ||
    currentAreaSlowNorm <= 0
  ) {
    return [];
  }

  return graph.contributors
    .flatMap((summary) => {
      if (summary.contributor.key === contributorKey) {
        return [];
      }

      const otherAreaFastWeights = graph.contributorAreaFastWeights.get(summary.contributor.key);
      const otherAreaSlowWeights = graph.contributorAreaSlowWeights.get(summary.contributor.key);

      if (!otherAreaFastWeights?.size || !otherAreaSlowWeights?.size) {
        return [];
      }

      const fastSimilarity = computeCosineSimilarity(
        currentAreaFastWeights,
        otherAreaFastWeights,
        currentAreaFastNorm,
        graph.contributorAreaFastNorms.get(summary.contributor.key) ?? 0,
      );
      const slowSimilarity = computeCosineSimilarity(
        currentAreaSlowWeights,
        otherAreaSlowWeights,
        currentAreaSlowNorm,
        graph.contributorAreaSlowNorms.get(summary.contributor.key) ?? 0,
      );
      const activityFactor = computeContributorActivityFactor(summary.lastCommitAgeDays);
      const broadnessPenalty = 1 - (graph.contributorBroadnesses.get(summary.contributor.key) ?? 0);
      const relationshipScore =
        (RELATIONSHIP_FAST_WEIGHT * fastSimilarity + RELATIONSHIP_SLOW_WEIGHT * slowSimilarity) *
        activityFactor *
        broadnessPenalty;

      if (relationshipScore <= 0) {
        return [];
      }

      const sharedAreaEntries = collectSharedAreaEntries(
        currentAreaFastWeights,
        currentAreaSlowWeights,
        otherAreaFastWeights,
        otherAreaSlowWeights,
      );

      if (!sharedAreaEntries.length) {
        return [];
      }

      return [
        {
          contributor: summary.contributor,
          relationshipScore,
          activityFactor,
          fastSimilarity,
          slowSimilarity,
          broadnessPenalty,
          contributorBroadness: summary.broadness,
          sharedAreaCount: sharedAreaEntries.length,
          contributorFileCount: summary.touchedFileCount,
          contributorCommitCount: summary.touchedCommitCount,
          contributorRecentCommitCount: summary.recentCommitCount,
          contributorLastCommitAgeDays: summary.lastCommitAgeDays,
          sampleSharedAreas: sharedAreaEntries
            .slice(0, sampleSize)
            .map((entry) => entry.areaPrefix),
        },
      ];
    })
    .sort(compareContributorRelationships)
    .slice(0, relationshipLimit);
}

function buildAreaPrefixAllocations(
  areaPrefixes: readonly string[],
): readonly { key: string; weight: number }[] {
  if (!areaPrefixes.length) {
    return [];
  }

  const totalWeight = (areaPrefixes.length * (areaPrefixes.length + 1)) / 2;

  return areaPrefixes.map((areaPrefix, index) => ({
    key: areaPrefix,
    weight: (index + 1) / totalWeight,
  }));
}

export function collectMeaningfulAreaPrefixes(
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): readonly string[] {
  return buildMeaningfulAreaPrefixes(filePath, packageRootDirectories);
}

function buildContributorAliasResolution(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  rawTouchCountsByKey: ReadonlyMap<string, number>,
): ContributorAliasResolution {
  const rawKeysByName = new Map<string, string[]>();
  const rawKeysByEmail = new Map<string, string[]>();

  for (const contributor of rawIdentitiesByKey.values()) {
    const aliasableNameKey = getAliasableContributorNameKey(contributor);

    if (aliasableNameKey) {
      let rawKeys = rawKeysByName.get(aliasableNameKey);

      if (!rawKeys) {
        rawKeys = [];
        rawKeysByName.set(aliasableNameKey, rawKeys);
      }

      rawKeys.push(contributor.key);
    }

    if (contributor.email) {
      let rawKeys = rawKeysByEmail.get(contributor.email);

      if (!rawKeys) {
        rawKeys = [];
        rawKeysByEmail.set(contributor.email, rawKeys);
      }

      rawKeys.push(contributor.key);
    }
  }

  const canonicalByRawKey = new Map<string, ContributorIdentity>();
  const rawKeysByRawKey = new Map<string, ReadonlySet<string>>();
  const visitedRawKeys = new Set<string>();

  for (const contributor of rawIdentitiesByKey.values()) {
    if (visitedRawKeys.has(contributor.key)) {
      continue;
    }

    const groupRawKeys = collectContributorAliasGroupKeys(
      contributor.key,
      rawIdentitiesByKey,
      rawKeysByName,
      rawKeysByEmail,
    );
    const canonicalContributor = createContributorIdentity(
      pickCanonicalContributorName(rawIdentitiesByKey, rawTouchCountsByKey, groupRawKeys),
      pickCanonicalContributorEmail(rawIdentitiesByKey, rawTouchCountsByKey, groupRawKeys),
    );

    for (const rawKey of groupRawKeys) {
      visitedRawKeys.add(rawKey);
      canonicalByRawKey.set(rawKey, canonicalContributor);
      rawKeysByRawKey.set(rawKey, groupRawKeys);
    }
  }

  return {
    canonicalByRawKey,
    rawKeysByRawKey,
  };
}

function addContributorEdgeWeight(
  contributorWeights: Map<string, Map<string, number>>,
  contributorKey: string,
  edgeKey: string,
  weight: number,
): void {
  if (weight <= 0) {
    return;
  }

  let weightsForContributor = contributorWeights.get(contributorKey);

  if (!weightsForContributor) {
    weightsForContributor = new Map<string, number>();
    contributorWeights.set(contributorKey, weightsForContributor);
  }

  weightsForContributor.set(edgeKey, (weightsForContributor.get(edgeKey) ?? 0) + weight);
}

function canonicalizeContributor(
  contributor: ContributorIdentity,
  aliasResolution: ContributorAliasResolution,
  selfContributorRawKeys: ReadonlySet<string>,
  selfContributor?: ContributorIdentity,
): ContributorIdentity {
  return selfContributor && selfContributorRawKeys.has(contributor.key)
    ? selfContributor
    : (aliasResolution.canonicalByRawKey.get(contributor.key) ?? contributor);
}

function collectContributorAliasGroupKeys(
  initialRawKey: string,
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  rawKeysByName: ReadonlyMap<string, readonly string[]>,
  rawKeysByEmail: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const queue = [initialRawKey];
  const rawKeys = new Set<string>();

  while (queue.length > 0) {
    const rawKey = queue.pop();

    if (!rawKey || rawKeys.has(rawKey)) {
      continue;
    }

    rawKeys.add(rawKey);

    const contributor = rawIdentitiesByKey.get(rawKey);

    if (!contributor) {
      continue;
    }

    const aliasableNameKey = getAliasableContributorNameKey(contributor);

    if (aliasableNameKey) {
      for (const linkedRawKey of rawKeysByName.get(aliasableNameKey) ?? []) {
        if (!rawKeys.has(linkedRawKey)) {
          queue.push(linkedRawKey);
        }
      }
    }

    if (contributor.email) {
      for (const linkedRawKey of rawKeysByEmail.get(contributor.email) ?? []) {
        if (!rawKeys.has(linkedRawKey)) {
          queue.push(linkedRawKey);
        }
      }
    }
  }

  return rawKeys;
}

function collectPackageRootsForGraph(
  touches: readonly ContributorTouch[],
  trackedPaths?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (trackedPaths?.size) {
    return collectPackageRootDirectories([...trackedPaths]);
  }

  return collectPackageRootDirectories(
    touches.flatMap((touch) => {
      if (touch.files?.length) {
        return touch.files.flatMap((file) =>
          [file.path, file.previousPath].filter((value): value is string => Boolean(value)),
        );
      }

      return touch.touchedPaths.map((touchedPath) => touchedPath.trim());
    }),
  );
}

function collectRawTouchedFiles(touch: ContributorTouch): readonly RawTouchedFile[] {
  if (touch.files?.length) {
    const seenFiles = new Set<string>();
    const rawFiles: RawTouchedFile[] = [];

    for (const file of touch.files) {
      const pathValue = normalizeRelativePath(file.path);

      if (!pathValue) {
        continue;
      }

      const previousPath = normalizeRelativePath(file.previousPath);
      const key = `${file.status ?? ""}\u0000${previousPath ?? ""}\u0000${pathValue}`;

      if (seenFiles.has(key)) {
        continue;
      }

      seenFiles.add(key);
      rawFiles.push({
        addedLineCount: file.addedLineCount,
        deletedLineCount: file.deletedLineCount,
        path: pathValue,
        previousPath,
        status: file.status?.trim() || undefined,
      });
    }

    return rawFiles;
  }

  const seenPaths = new Set<string>();
  const rawFiles: RawTouchedFile[] = [];

  for (const touchedPath of touch.touchedPaths) {
    const pathValue = normalizeRelativePath(touchedPath);

    if (!pathValue || seenPaths.has(pathValue)) {
      continue;
    }

    seenPaths.add(pathValue);
    rawFiles.push({
      path: pathValue,
    });
  }

  return rawFiles;
}

function collectSharedAreaEntries(
  leftFastWeights: ReadonlyMap<string, number>,
  leftSlowWeights: ReadonlyMap<string, number>,
  rightFastWeights: ReadonlyMap<string, number>,
  rightSlowWeights: ReadonlyMap<string, number>,
): readonly RelationshipAreaEntry[] {
  const combinedLeftWeights = combineEdgeWeights(leftFastWeights, leftSlowWeights);
  const combinedRightWeights = combineEdgeWeights(rightFastWeights, rightSlowWeights);
  const smallerCombinedWeights =
    combinedLeftWeights.size <= combinedRightWeights.size
      ? combinedLeftWeights
      : combinedRightWeights;
  const largerCombinedWeights =
    smallerCombinedWeights === combinedLeftWeights ? combinedRightWeights : combinedLeftWeights;
  const sharedEntries: RelationshipAreaEntry[] = [];

  for (const [areaPrefix, leftWeight] of smallerCombinedWeights.entries()) {
    const rightWeight = largerCombinedWeights.get(areaPrefix);

    if (rightWeight === undefined) {
      continue;
    }

    sharedEntries.push({
      areaPrefix,
      combinedWeight: Math.min(leftWeight, rightWeight),
    });
  }

  return sharedEntries.sort(compareRelationshipAreaEntries);
}

function combineEdgeWeights(
  fastWeights: ReadonlyMap<string, number>,
  slowWeights: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const combinedWeights = new Map<string, number>();

  for (const [key, weight] of fastWeights.entries()) {
    combinedWeights.set(key, RELATIONSHIP_FAST_WEIGHT * weight);
  }

  for (const [key, weight] of slowWeights.entries()) {
    combinedWeights.set(key, (combinedWeights.get(key) ?? 0) + RELATIONSHIP_SLOW_WEIGHT * weight);
  }

  return combinedWeights;
}

function getCombinedContributorWeights(
  fastContributorWeights: ReadonlyMap<string, ReadonlyMap<string, number>>,
  slowContributorWeights: ReadonlyMap<string, ReadonlyMap<string, number>>,
  contributorKey: string,
): Map<string, number> {
  return new Map(
    combineEdgeWeights(
      fastContributorWeights.get(contributorKey) ?? new Map<string, number>(),
      slowContributorWeights.get(contributorKey) ?? new Map<string, number>(),
    ),
  );
}

function addScaledWeights(
  targetWeights: Map<string, number>,
  sourceWeights: ReadonlyMap<string, number>,
  scale: number,
): void {
  if (scale <= 0 || !sourceWeights.size) {
    return;
  }

  for (const [key, weight] of sourceWeights.entries()) {
    targetWeights.set(key, (targetWeights.get(key) ?? 0) + weight * scale);
  }
}

function collectCombinedLineageTotals(
  graph: ContributorRelationshipGraph,
): ReadonlyMap<string, number> {
  const lineageTotals = new Map<string, number>();

  for (const contributor of graph.contributors) {
    const combinedWeights = getCombinedContributorWeights(
      graph.contributorFileFastWeights,
      graph.contributorFileSlowWeights,
      contributor.contributor.key,
    );

    addScaledWeights(lineageTotals, combinedWeights, 1);
  }

  return lineageTotals;
}

function compareContributorRelationships(
  left: ContributorRelationship,
  right: ContributorRelationship,
): number {
  return (
    right.relationshipScore - left.relationshipScore ||
    right.fastSimilarity - left.fastSimilarity ||
    right.slowSimilarity - left.slowSimilarity ||
    right.broadnessPenalty - left.broadnessPenalty ||
    formatContributorIdentity(left.contributor).localeCompare(
      formatContributorIdentity(right.contributor),
    )
  );
}

function compareContributorSummaries(left: ContributorSummary, right: ContributorSummary): number {
  return (
    right.areaSlowWeight - left.areaSlowWeight ||
    right.areaFastWeight - left.areaFastWeight ||
    right.fileSlowWeight - left.fileSlowWeight ||
    right.touchedCommitCount - left.touchedCommitCount ||
    right.recentCommitCount - left.recentCommitCount ||
    formatContributorIdentity(left.contributor).localeCompare(
      formatContributorIdentity(right.contributor),
    )
  );
}

function compareRelationshipAreaEntries(
  left: RelationshipAreaEntry,
  right: RelationshipAreaEntry,
): number {
  return (
    right.combinedWeight - left.combinedWeight || left.areaPrefix.localeCompare(right.areaPrefix)
  );
}

function computeBreadthPenalty(fileCount: number): number {
  return 1 / (1 + Math.log1p(Math.max(1, fileCount)));
}

function computeChangeMagnitude(addedLineCount?: number, deletedLineCount?: number): number {
  if (
    typeof addedLineCount !== "number" ||
    !Number.isFinite(addedLineCount) ||
    typeof deletedLineCount !== "number" ||
    !Number.isFinite(deletedLineCount)
  ) {
    return 1;
  }

  return Math.log1p(Math.min(addedLineCount + deletedLineCount, 200));
}

function computeCommitSignals(
  rawTouchedFiles: readonly RawTouchedFile[],
  packageRootDirectories: ReadonlySet<string>,
  message?: string,
): CommitSignals {
  if (!rawTouchedFiles.length) {
    return {
      quality: 0,
      spreadPenalty: 0,
    };
  }

  const packageRootCounts = collectPackageRootCounts(rawTouchedFiles, packageRootDirectories);
  const packageRootEntropy = computeNormalizedEntropy(packageRootCounts.values());
  const medianChangedLines = computeMedianChangedLines(rawTouchedFiles);
  const generatedShare =
    rawTouchedFiles.filter((file) => GENERATED_PATH_PATTERN.test(file.path)).length /
    rawTouchedFiles.length;
  const mechanicalMessagePenalty = MECHANICAL_MESSAGE_PATTERN.test(message ?? "") ? 0.35 : 0;
  const renameOnlyPenalty =
    rawTouchedFiles.every((file) => file.status?.startsWith("R")) && rawTouchedFiles.length > 0
      ? 0.35
      : 0;
  const breadthPenalty = Math.min(0.25, Math.log1p(Math.max(0, rawTouchedFiles.length - 1)) * 0.06);
  const spreadPenalty = packageRootEntropy * 0.2;
  const generatedPenalty = generatedShare * 0.25;
  const tinyChangePenalty = medianChangedLines <= 2 && rawTouchedFiles.length >= 12 ? 0.15 : 0;
  const noiseScore = clamp(
    breadthPenalty +
      spreadPenalty +
      mechanicalMessagePenalty +
      renameOnlyPenalty +
      generatedPenalty +
      tinyChangePenalty,
    0,
    0.95,
  );

  return {
    quality: 1 - noiseScore,
    spreadPenalty: 1 / (1 + packageRootEntropy),
  };
}

function computeContributorActivityFactor(lastCommitAgeDays: number): number {
  if (!Number.isFinite(lastCommitAgeDays) || lastCommitAgeDays >= ACTIVITY_SLOPE_DAYS) {
    return 0;
  }

  if (lastCommitAgeDays <= ACTIVITY_FULL_WEIGHT_DAYS) {
    return 1;
  }

  const normalizedAge =
    (lastCommitAgeDays - ACTIVITY_FULL_WEIGHT_DAYS) /
    (ACTIVITY_SLOPE_DAYS - ACTIVITY_FULL_WEIGHT_DAYS);

  return 0.5 * (1 + Math.cos(Math.PI * normalizedAge));
}

function computeContributorBroadnesses(
  contributorAreaSlowWeights: ReadonlyMap<string, ReadonlyMap<string, number>>,
  noiseTotals: ReadonlyMap<string, number>,
  noiseWeights: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  return new Map(
    [...contributorAreaSlowWeights.entries()].map(([contributorKey, areaSlowWeights]) => {
      const areaEntropy = computeNormalizedEntropy(areaSlowWeights.values());
      const noiseAverage =
        (noiseTotals.get(contributorKey) ?? 0) / Math.max(1, noiseWeights.get(contributorKey) ?? 0);

      return [contributorKey, clamp(0.7 * areaEntropy + 0.3 * noiseAverage, 0, 0.95)];
    }),
  );
}

function computeCosineSimilarity(
  leftWeights: ReadonlyMap<string, number>,
  rightWeights: ReadonlyMap<string, number>,
  leftNorm: number,
  rightNorm: number,
): number {
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  const smallerWeights = leftWeights.size <= rightWeights.size ? leftWeights : rightWeights;
  const largerWeights = smallerWeights === leftWeights ? rightWeights : leftWeights;
  let dotProduct = 0;

  for (const [key, leftWeight] of smallerWeights.entries()) {
    const rightWeight = largerWeights.get(key);

    if (rightWeight === undefined) {
      continue;
    }

    dotProduct += leftWeight * rightWeight;
  }

  return dotProduct > 0 ? dotProduct / (leftNorm * rightNorm) : 0;
}

function computeMapNorm(weights: ReadonlyMap<string, number>): number {
  return Math.sqrt([...weights.values()].reduce((sum, weight) => sum + weight * weight, 0));
}

function computeMedianChangedLines(rawTouchedFiles: readonly RawTouchedFile[]): number {
  const changedLines = rawTouchedFiles.map((file) =>
    typeof file.addedLineCount === "number" &&
    Number.isFinite(file.addedLineCount) &&
    typeof file.deletedLineCount === "number" &&
    Number.isFinite(file.deletedLineCount)
      ? file.addedLineCount + file.deletedLineCount
      : 1,
  );

  if (!changedLines.length) {
    return 0;
  }

  const hasMeasuredStats = rawTouchedFiles.some(
    (file) =>
      typeof file.addedLineCount === "number" &&
      Number.isFinite(file.addedLineCount) &&
      typeof file.deletedLineCount === "number" &&
      Number.isFinite(file.deletedLineCount),
  );

  if (!hasMeasuredStats) {
    return 1;
  }

  changedLines.sort((left, right) => left - right);

  const middleIndex = Math.floor(changedLines.length / 2);

  if (changedLines.length % 2 === 1) {
    return changedLines[middleIndex] ?? 0;
  }

  return ((changedLines[middleIndex - 1] ?? 0) + (changedLines[middleIndex] ?? 0)) / 2;
}

function computeNormalizedEntropy(values: Iterable<number>): number {
  const filteredValues = [...values].filter((value) => value > 0);
  const total = filteredValues.reduce((sum, value) => sum + value, 0);

  if (filteredValues.length <= 1 || total <= 0) {
    return 0;
  }

  const entropy = filteredValues.reduce((sum, value) => {
    const probability = value / total;

    return probability > 0 ? sum - probability * Math.log(probability) : sum;
  }, 0);
  const maxEntropy = Math.log(filteredValues.length);

  return maxEntropy > 0 ? clamp(entropy / maxEntropy, 0, 1) : 0;
}

function computeVectorNorms(
  contributorWeights: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ReadonlyMap<string, number> {
  return new Map(
    [...contributorWeights.entries()].map(([contributorKey, weights]) => [
      contributorKey,
      computeMapNorm(weights),
    ]),
  );
}

function decayForHalfLife(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) {
    return 0;
  }

  return Math.pow(2, -ageDays / halfLifeDays);
}

function areTouchesInReverseChronologicalOrder(touches: readonly ContributorTouch[]): boolean {
  let previousCommittedAtMs = Number.POSITIVE_INFINITY;

  for (const touch of touches) {
    const committedAtMs = touch.committedAtMs ?? 0;

    if (committedAtMs > previousCommittedAtMs) {
      return false;
    }

    previousCommittedAtMs = committedAtMs;
  }

  return true;
}

function findContributorLineageKey(
  rawTouchedFile: RawTouchedFile,
  trackedPaths: ReadonlySet<string> | undefined,
  pathToLineageKey: Map<string, string>,
  lineageCurrentPaths: Map<string, string>,
): string | undefined {
  const existingLineageKey =
    pathToLineageKey.get(rawTouchedFile.path) ??
    (rawTouchedFile.previousPath ? pathToLineageKey.get(rawTouchedFile.previousPath) : undefined);

  if (trackedPaths?.has(rawTouchedFile.path)) {
    const lineageKey = existingLineageKey ?? `${FILE_LINEAGE_PREFIX}${rawTouchedFile.path}`;

    pathToLineageKey.set(rawTouchedFile.path, lineageKey);

    if (rawTouchedFile.previousPath) {
      pathToLineageKey.set(rawTouchedFile.previousPath, lineageKey);
    }

    lineageCurrentPaths.set(lineageKey, rawTouchedFile.path);

    return lineageKey;
  }

  if (existingLineageKey) {
    pathToLineageKey.set(rawTouchedFile.path, existingLineageKey);

    if (rawTouchedFile.previousPath) {
      pathToLineageKey.set(rawTouchedFile.previousPath, existingLineageKey);
    }

    return existingLineageKey;
  }

  if (trackedPaths) {
    return undefined;
  }

  const lineageKey = `${FILE_LINEAGE_PREFIX}${rawTouchedFile.path}`;

  pathToLineageKey.set(rawTouchedFile.path, lineageKey);

  if (rawTouchedFile.previousPath) {
    pathToLineageKey.set(rawTouchedFile.previousPath, lineageKey);
  }

  lineageCurrentPaths.set(lineageKey, rawTouchedFile.path);

  return lineageKey;
}

function getAgeDays(nowMs: number, committedAtMs?: number): number {
  if (typeof committedAtMs !== "number" || !Number.isFinite(committedAtMs)) {
    return 0;
  }

  return Math.max(0, (nowMs - committedAtMs) / DAY_MS);
}

function getCurrentPathForLineage(
  lineageKey: string,
  lineageCurrentPaths: ReadonlyMap<string, string>,
  fallbackPath: string,
): string {
  return lineageCurrentPaths.get(lineageKey) ?? fallbackPath;
}

function getDirectoryPrefixesWithinScope(
  filePath: string,
  scopeRootDirectory: string,
): readonly string[] {
  const fileDirectory = getRelativeDirectory(filePath);

  if (!fileDirectory || fileDirectory === scopeRootDirectory) {
    return [];
  }

  const scopePrefix = scopeRootDirectory ? `${scopeRootDirectory}/` : "";
  const relativeDirectory = fileDirectory.startsWith(scopePrefix)
    ? fileDirectory.slice(scopePrefix.length)
    : fileDirectory;
  const segments = relativeDirectory.split("/").filter(Boolean);
  const directories: string[] = [];
  let currentDirectory = scopeRootDirectory;

  for (const segment of segments) {
    currentDirectory = currentDirectory ? `${currentDirectory}/${segment}` : segment;
    directories.push(currentDirectory);
  }

  return directories;
}

function getRelativeDirectory(filePath: string): string {
  const directory = path.posix.dirname(filePath);

  return directory === "." ? "" : directory;
}

function getTopLevelScopeRootDirectory(filePath: string): string | undefined {
  const segments = filePath.split("/").filter(Boolean);

  return segments.length > 1 ? segments[0] : undefined;
}

function looksLikeBotContributor(contributor: ContributorIdentity): boolean {
  return (
    BOT_CONTRIBUTOR_PATTERN.test(contributor.name) ||
    BOT_CONTRIBUTOR_PATTERN.test(contributor.email ?? "")
  );
}

function normalizeContributorEmail(value?: string): string | undefined {
  const normalizedEmail = value?.trim().toLowerCase();

  return normalizedEmail || undefined;
}

function normalizeContributorName(value?: string): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function normalizeContributorNameKey(value?: string): string | undefined {
  const normalizedName = normalizeContributorName(value).toLowerCase();

  return normalizedName || undefined;
}

function normalizeRelativePath(value?: string): string {
  const normalizedValue =
    value
      ?.trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "") ?? "";

  return normalizedValue.replace(/\/+/g, "/");
}

function normalizeTouchedFiles(
  rawTouchedFiles: readonly RawTouchedFile[],
  trackedPaths: ReadonlySet<string> | undefined,
  pathToLineageKey: Map<string, string>,
  lineageCurrentPaths: Map<string, string>,
  packageRootDirectories: ReadonlySet<string>,
): NormalizedTouchFiles {
  const filesByLineage = new Map<string, NormalizedContributorFile>();
  const relevantRawTouchedFiles: RawTouchedFile[] = [];

  for (const rawTouchedFile of rawTouchedFiles) {
    const lineageKey = findContributorLineageKey(
      rawTouchedFile,
      trackedPaths,
      pathToLineageKey,
      lineageCurrentPaths,
    );

    if (!lineageKey) {
      continue;
    }

    relevantRawTouchedFiles.push(rawTouchedFile);

    const currentPath = getCurrentPathForLineage(
      lineageKey,
      lineageCurrentPaths,
      rawTouchedFile.path,
    );
    const magnitude = computeChangeMagnitude(
      rawTouchedFile.addedLineCount,
      rawTouchedFile.deletedLineCount,
    );
    const areaPrefixes = buildMeaningfulAreaPrefixes(currentPath, packageRootDirectories);
    const existingFile = filesByLineage.get(lineageKey);

    filesByLineage.set(lineageKey, {
      areaPrefixes,
      currentPath,
      lineageKey,
      magnitude: existingFile ? existingFile.magnitude + magnitude : magnitude,
    });
  }

  return {
    files: [...filesByLineage.values()],
    relevantRawTouchedFiles,
  };
}

function pickFirstContributorEmail(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  contributorKeys: ReadonlySet<string>,
): string | undefined {
  for (const contributorKey of contributorKeys) {
    const contributor = rawIdentitiesByKey.get(contributorKey);

    if (contributor?.email) {
      return contributor.email;
    }
  }

  return undefined;
}

function pickFirstContributorName(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  contributorKeys: ReadonlySet<string>,
): string {
  for (const contributorKey of contributorKeys) {
    const contributor = rawIdentitiesByKey.get(contributorKey);

    if (contributor?.name) {
      return contributor.name;
    }
  }

  return "Unknown Contributor";
}

function pickCanonicalContributorEmail(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  rawTouchCountsByKey: ReadonlyMap<string, number>,
  contributorKeys: ReadonlySet<string>,
): string | undefined {
  const emailScores = new Map<string, number>();

  for (const contributorKey of contributorKeys) {
    const contributor = rawIdentitiesByKey.get(contributorKey);
    const email = contributor?.email;

    if (!email) {
      continue;
    }

    emailScores.set(
      email,
      (emailScores.get(email) ?? 0) +
        getContributorEmailPreferenceScore(email) +
        (rawTouchCountsByKey.get(contributorKey) ?? 0),
    );
  }

  return [...emailScores.entries()]
    .sort(
      ([leftEmail, leftScore], [rightEmail, rightScore]) =>
        rightScore - leftScore || leftEmail.localeCompare(rightEmail),
    )
    .at(0)?.[0];
}

function pickCanonicalContributorName(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  rawTouchCountsByKey: ReadonlyMap<string, number>,
  contributorKeys: ReadonlySet<string>,
): string {
  const nameScores = new Map<string, number>();

  for (const contributorKey of contributorKeys) {
    const contributor = rawIdentitiesByKey.get(contributorKey);

    if (!contributor?.name) {
      continue;
    }

    nameScores.set(
      contributor.name,
      (nameScores.get(contributor.name) ?? 0) +
        getContributorNamePreferenceScore(contributor.name) +
        (rawTouchCountsByKey.get(contributorKey) ?? 0),
    );
  }

  return (
    [...nameScores.entries()]
      .sort(
        ([leftName, leftScore], [rightName, rightScore]) =>
          rightScore - leftScore || leftName.localeCompare(rightName),
      )
      .at(0)?.[0] ?? "Unknown Contributor"
  );
}

function resolveScopeRootDirectory(
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): string | undefined {
  const packageRootDirectory = findNearestPackageRoot(
    getRelativeDirectory(filePath),
    packageRootDirectories,
  );

  if (packageRootDirectory) {
    return packageRootDirectory;
  }

  return getTopLevelScopeRootDirectory(filePath);
}

function buildMeaningfulAreaPrefixes(
  filePath: string,
  packageRootDirectories: ReadonlySet<string>,
): readonly string[] {
  const scopeRootDirectory = resolveScopeRootDirectory(filePath, packageRootDirectories);

  if (!scopeRootDirectory) {
    return [];
  }

  const directoriesWithinScope = getDirectoryPrefixesWithinScope(filePath, scopeRootDirectory);
  const meaningfulDirectories =
    directoriesWithinScope.length <= MEANINGFUL_AREA_PREFIX_COUNT
      ? directoriesWithinScope
      : directoriesWithinScope.slice(-MEANINGFUL_AREA_PREFIX_COUNT);

  return [scopeRootDirectory, ...meaningfulDirectories];
}

function getAliasableContributorNameKey(contributor: ContributorIdentity): string | undefined {
  const normalizedName = normalizeContributorNameKey(contributor.name);

  if (!normalizedName || normalizedName === "unknown contributor") {
    return undefined;
  }

  return normalizedName;
}

function getContributorEmailPreferenceScore(email: string): number {
  let score = 10;

  if (!isNoreplyEmail(email)) {
    score += 100;
  }

  return score;
}

function getContributorNamePreferenceScore(name: string): number {
  let score = 10;

  if (!looksLikeEmailValue(name)) {
    score += 100;
  }

  if (normalizeContributorNameKey(name) !== "unknown contributor") {
    score += 10;
  }

  return score;
}

function isNoreplyEmail(email: string): boolean {
  return email.includes("noreply");
}

function looksLikeEmailValue(value: string): boolean {
  return /\S+@\S+/.test(value);
}

function resolveSelfContributor(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
  aliasResolution: ContributorAliasResolution,
  selector?: ContributorSelector,
): SelfContributorResolution {
  const normalizedEmail = normalizeContributorEmail(selector?.email);
  const normalizedName = normalizeContributorNameKey(selector?.name);

  if (!normalizedEmail && !normalizedName) {
    return {
      rawKeys: new Set<string>(),
    };
  }

  const matchingRawKeys = new Set<string>();

  for (const contributor of rawIdentitiesByKey.values()) {
    const matchesEmail = normalizedEmail && contributor.email === normalizedEmail;
    const matchesName =
      normalizedName && normalizeContributorNameKey(contributor.name) === normalizedName;

    if (matchesEmail || matchesName) {
      for (const rawKey of aliasResolution.rawKeysByRawKey.get(contributor.key) ?? [
        contributor.key,
      ]) {
        matchingRawKeys.add(rawKey);
      }
    }
  }

  if (!matchingRawKeys.size) {
    return {
      rawKeys: matchingRawKeys,
    };
  }

  return {
    contributor: createContributorIdentity(
      selector?.name ?? pickFirstContributorName(rawIdentitiesByKey, matchingRawKeys),
      selector?.email ?? pickFirstContributorEmail(rawIdentitiesByKey, matchingRawKeys),
    ),
    rawKeys: matchingRawKeys,
  };
}

function shouldIgnoreContributor(
  contributor: ContributorIdentity,
  selfContributorRawKeys: ReadonlySet<string>,
): boolean {
  return !selfContributorRawKeys.has(contributor.key) && looksLikeBotContributor(contributor);
}

function sumWeightMap(weights?: ReadonlyMap<string, number>): number {
  return weights ? [...weights.values()].reduce((sum, weight) => sum + weight, 0) : 0;
}

function collectPackageRootCounts(
  rawTouchedFiles: readonly RawTouchedFile[],
  packageRootDirectories: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const file of rawTouchedFiles) {
    const scopeRoot = resolveScopeRootDirectory(file.path, packageRootDirectories) ?? file.path;

    counts.set(scopeRoot, (counts.get(scopeRoot) ?? 0) + 1);
  }

  return counts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
