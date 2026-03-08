import * as path from "node:path";
import { collectPackageRootDirectories, findNearestPackageRoot } from "./package-root";

const ACTIVE_CONTRIBUTOR_WINDOW_DAYS = 90;
const BULK_COMMIT_EXPONENT = 0.7;
const CONTRIBUTOR_ACTIVITY_FULL_WEIGHT_DAYS = 30;
const CONTRIBUTOR_ACTIVITY_SLOPE_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RELATIONSHIP_LIMIT = 10;
const DEFAULT_SAMPLE_SIZE = 3;
const DIRECTORY_NODE_PREFIX = "dir:";
const DIRECTORY_RIPPLE_DECAY = 0.5;
const FILE_NODE_PREFIX = "file:";
const NODE_SPECIFICITY_EXPONENT = 1.5;
const PROFILE_RECENCY_FLOOR = 0.15;
const PROFILE_RECENCY_SLOPE_DAYS = 50;
const RECENT_ACTIVITY_WINDOW_DAYS = 21;
const RELATIONSHIP_F_BETA = 0.5;
const SPECIALIZATION_BASELINE = 0.25;
const SPECIALIZATION_EPSILON = 1e-6;

export interface ContributorIdentity {
  readonly key: string;
  readonly name: string;
  readonly email?: string;
}

export interface ContributorTouch {
  readonly contributor: ContributorIdentity;
  readonly touchedPaths: readonly string[];
  readonly committedAtMs?: number;
}

export interface ContributorSummary {
  readonly contributor: ContributorIdentity;
  readonly touchedFileCount: number;
  readonly touchedCommitCount: number;
  readonly recentCommitCount: number;
  readonly lastCommitAgeDays: number;
  readonly profileWeight: number;
  readonly recentActivityWeight: number;
}

export interface ContributorSelector {
  readonly name?: string;
  readonly email?: string;
}

export interface ContributorRelationship {
  readonly contributor: ContributorIdentity;
  readonly relationshipScore: number;
  readonly activityFactor: number;
  readonly overlapWeight: number;
  readonly recentOverlapWeight: number;
  readonly precision: number;
  readonly recall: number;
  readonly fScore: number;
  readonly sharedFileCount: number;
  readonly sharedNodeCount: number;
  readonly contributorFileCount: number;
  readonly contributorCommitCount: number;
  readonly contributorRecentCommitCount: number;
  readonly contributorLastCommitAgeDays: number;
  readonly sampleSharedPaths: readonly string[];
}

export interface ContributorRelationshipGraph {
  readonly contributors: readonly ContributorSummary[];
  readonly contributorFiles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly contributorCommitCounts: ReadonlyMap<string, number>;
  readonly contributorRecentCommitCounts: ReadonlyMap<string, number>;
  readonly contributorLastCommitAgeDays: ReadonlyMap<string, number>;
  readonly contributorProfileWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorRecentActivityWeights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contributorTotalProfileWeights: ReadonlyMap<string, number>;
  readonly contributorTotalRecentActivityWeights: ReadonlyMap<string, number>;
  readonly contributorsByFile: ReadonlyMap<string, readonly string[]>;
  readonly identitiesByKey: ReadonlyMap<string, ContributorIdentity>;
  readonly currentContributorKey?: string;
}

export interface BuildContributorRelationshipGraphOptions {
  readonly currentContributor?: ContributorSelector;
  readonly nowMs?: number;
  readonly trackedPaths?: ReadonlySet<string>;
}

export interface RankContributorRelationshipOptions {
  readonly limit?: number;
  readonly sampleSize?: number;
}

interface NormalizedContributorTouch {
  readonly ageDays: number;
  readonly contributor: ContributorIdentity;
  readonly spreadPenalty: number;
  readonly touchedPaths: readonly string[];
}

interface OverlapEntry {
  readonly nodeKey: string;
  readonly overlapWeight: number;
  readonly recentOverlapWeight: number;
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

  for (const touch of touches) {
    rawIdentitiesByKey.set(touch.contributor.key, touch.contributor);
  }

  const selfContributor = resolveSelfContributor(rawIdentitiesByKey, options.currentContributor);
  const activeContributorsByNode = new Map<string, Set<string>>();
  const contributorFiles = new Map<string, Set<string>>();
  const contributorCommitCounts = new Map<string, number>();
  const contributorRecentCommitCounts = new Map<string, number>();
  const contributorLastCommitAgeDays = new Map<string, number>();
  const contributorsByFile = new Map<string, Set<string>>();
  const identitiesByKey = new Map<string, ContributorIdentity>();
  const normalizedTouches: NormalizedContributorTouch[] = [];

  for (const touch of touches) {
    const contributor = canonicalizeContributor(
      touch.contributor,
      selfContributor.rawKeys,
      selfContributor.contributor,
    );
    const touchedPaths = collectTrackedTouchedPaths(touch.touchedPaths, trackedPaths);

    if (!touchedPaths.length) {
      continue;
    }

    const ageDays = getAgeDays(nowMs, touch.committedAtMs);
    const spreadPenalty = computeSpreadPenalty(touchedPaths, packageRootDirectories);

    normalizedTouches.push({
      ageDays,
      contributor,
      spreadPenalty,
      touchedPaths,
    });

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

    if (ageDays <= CONTRIBUTOR_ACTIVITY_SLOPE_DAYS) {
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

    for (const filePath of touchedPaths) {
      filesForContributor.add(filePath);

      let contributorKeys = contributorsByFile.get(filePath);

      if (!contributorKeys) {
        contributorKeys = new Set<string>();
        contributorsByFile.set(filePath, contributorKeys);
      }

      contributorKeys.add(contributor.key);

      if (ageDays <= ACTIVE_CONTRIBUTOR_WINDOW_DAYS) {
        addContributorToNode(activeContributorsByNode, fileNodeKey(filePath), contributor.key);

        for (const directoryPath of listAncestorDirectories(filePath)) {
          addContributorToNode(
            activeContributorsByNode,
            directoryNodeKey(directoryPath),
            contributor.key,
          );
        }
      }
    }
  }

  const contributorProfileWeights = buildContributorFeatureMaps(
    normalizedTouches,
    activeContributorsByNode,
    profileRecencyWeight,
  );
  const contributorRecentActivityWeights = buildContributorFeatureMaps(
    normalizedTouches,
    activeContributorsByNode,
    recentActivityWeight,
  );
  const contributorTotalProfileWeights = sumContributorWeightMaps(contributorProfileWeights);
  const contributorTotalRecentActivityWeights = sumContributorWeightMaps(
    contributorRecentActivityWeights,
  );
  const contributors = [...identitiesByKey.values()]
    .map((contributor) => ({
      contributor,
      touchedFileCount: contributorFiles.get(contributor.key)?.size ?? 0,
      touchedCommitCount: contributorCommitCounts.get(contributor.key) ?? 0,
      recentCommitCount: contributorRecentCommitCounts.get(contributor.key) ?? 0,
      lastCommitAgeDays:
        contributorLastCommitAgeDays.get(contributor.key) ?? Number.POSITIVE_INFINITY,
      profileWeight: contributorTotalProfileWeights.get(contributor.key) ?? 0,
      recentActivityWeight: contributorTotalRecentActivityWeights.get(contributor.key) ?? 0,
    }))
    .filter((summary) => summary.touchedCommitCount > 0)
    .sort(compareContributorSummaries);

  return {
    contributors,
    contributorFiles,
    contributorCommitCounts,
    contributorRecentCommitCounts,
    contributorLastCommitAgeDays,
    contributorProfileWeights,
    contributorRecentActivityWeights,
    contributorTotalProfileWeights,
    contributorTotalRecentActivityWeights,
    contributorsByFile: new Map(
      [...contributorsByFile.entries()].map(([filePath, contributorKeys]) => [
        filePath,
        [...contributorKeys].sort(),
      ]),
    ),
    identitiesByKey,
    currentContributorKey: selfContributor.contributor?.key,
  };
}

export function findContributor(
  graph: ContributorRelationshipGraph,
  selector: ContributorSelector,
): ContributorSummary | undefined {
  const normalizedEmail = normalizeContributorEmail(selector.email);

  if (normalizedEmail) {
    const emailMatch = graph.contributors.find(
      (summary) => summary.contributor.key === `email:${normalizedEmail}`,
    );

    if (emailMatch) {
      return emailMatch;
    }
  }

  const normalizedName = normalizeContributorNameKey(selector.name);

  if (!normalizedName) {
    return undefined;
  }

  const matches = graph.contributors.filter(
    (summary) => normalizeContributorNameKey(summary.contributor.name) === normalizedName,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

export function rankContributorRelationships(
  graph: ContributorRelationshipGraph,
  contributorKey: string,
  options: RankContributorRelationshipOptions = {},
): readonly ContributorRelationship[] {
  const currentProfileWeights = graph.contributorProfileWeights.get(contributorKey);
  const currentRecentActivityWeights = graph.contributorRecentActivityWeights.get(contributorKey);
  const currentTotalProfileWeight = graph.contributorTotalProfileWeights.get(contributorKey) ?? 0;
  const currentFiles = graph.contributorFiles.get(contributorKey);

  if (
    !currentProfileWeights?.size ||
    !currentRecentActivityWeights ||
    !currentFiles ||
    currentTotalProfileWeight <= 0
  ) {
    return [];
  }

  const relationshipLimit = options.limit ?? DEFAULT_RELATIONSHIP_LIMIT;
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  return graph.contributors
    .flatMap((summary) => {
      if (summary.contributor.key === contributorKey || summary.profileWeight <= 0) {
        return [];
      }

      const otherProfileWeights = graph.contributorProfileWeights.get(summary.contributor.key);
      const otherFiles = graph.contributorFiles.get(summary.contributor.key);
      const activityFactor = computeContributorActivityFactor(summary.lastCommitAgeDays);

      if (!otherProfileWeights?.size || !otherFiles || activityFactor <= 0) {
        return [];
      }

      const overlapEntries = collectOverlapEntries(
        currentProfileWeights,
        otherProfileWeights,
        currentRecentActivityWeights,
        graph.contributorRecentActivityWeights.get(summary.contributor.key),
      );

      if (!overlapEntries.length) {
        return [];
      }

      const overlapWeight = overlapEntries.reduce((sum, entry) => sum + entry.overlapWeight, 0);
      const recentOverlapWeight = overlapEntries.reduce(
        (sum, entry) => sum + entry.recentOverlapWeight,
        0,
      );
      const precision = overlapWeight / summary.profileWeight;
      const recall = overlapWeight / currentTotalProfileWeight;
      const fScore = computeFScore(RELATIONSHIP_F_BETA, precision, recall);
      const relationshipScore = Math.log1p(overlapWeight) * fScore * activityFactor;

      if (relationshipScore <= 0) {
        return [];
      }

      return [
        {
          contributor: summary.contributor,
          relationshipScore,
          activityFactor,
          overlapWeight,
          recentOverlapWeight,
          precision,
          recall,
          fScore,
          sharedFileCount: countSharedFiles(currentFiles, otherFiles),
          sharedNodeCount: overlapEntries.length,
          contributorFileCount: summary.touchedFileCount,
          contributorCommitCount: summary.touchedCommitCount,
          contributorRecentCommitCount: summary.recentCommitCount,
          contributorLastCommitAgeDays: summary.lastCommitAgeDays,
          sampleSharedPaths: overlapEntries
            .slice()
            .sort(compareOverlapEntries)
            .slice(0, sampleSize)
            .map((entry) => formatNodeKey(entry.nodeKey)),
        },
      ];
    })
    .sort(compareContributorRelationships)
    .slice(0, relationshipLimit);
}

function buildContributorFeatureMaps(
  touches: readonly NormalizedContributorTouch[],
  activeContributorsByNode: ReadonlyMap<string, ReadonlySet<string>>,
  recencyWeightForAgeDays: (ageDays: number) => number,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const rawFileWeightsByContributor = new Map<string, Map<string, number>>();
  const rawFileTotals = new Map<string, number>();

  for (const touch of touches) {
    const recencyWeight = recencyWeightForAgeDays(touch.ageDays);

    if (recencyWeight <= 0) {
      continue;
    }

    const bulkPenalty = computeBulkPenalty(touch.touchedPaths.length);
    let rawFileWeights = rawFileWeightsByContributor.get(touch.contributor.key);

    if (!rawFileWeights) {
      rawFileWeights = new Map<string, number>();
      rawFileWeightsByContributor.set(touch.contributor.key, rawFileWeights);
    }

    for (const filePath of touch.touchedPaths) {
      const baseWeight = recencyWeight * bulkPenalty * touch.spreadPenalty;

      rawFileWeights.set(filePath, (rawFileWeights.get(filePath) ?? 0) + baseWeight);
      rawFileTotals.set(filePath, (rawFileTotals.get(filePath) ?? 0) + baseWeight);
    }
  }

  const rawNodeWeightsByContributor = new Map<string, Map<string, number>>();

  for (const [contributorKey, rawFileWeights] of rawFileWeightsByContributor.entries()) {
    const rawNodeWeights = new Map<string, number>();

    for (const [filePath, rawFileWeight] of rawFileWeights.entries()) {
      const rawFileTotal = rawFileTotals.get(filePath) ?? 0;

      if (rawFileTotal <= 0) {
        continue;
      }

      const ownershipShare = rawFileWeight / rawFileTotal;
      const fileWeight =
        ownershipShare *
        computeNodeSpecificity(activeContributorsByNode.get(fileNodeKey(filePath))?.size ?? 0);

      addWeight(rawNodeWeights, fileNodeKey(filePath), fileWeight);

      const ancestorDirectories = listAncestorDirectories(filePath);

      ancestorDirectories.forEach((directoryPath, index) => {
        const rippleWeight = Math.pow(DIRECTORY_RIPPLE_DECAY, index + 1);
        const directoryWeight =
          fileWeight *
          rippleWeight *
          computeNodeSpecificity(
            activeContributorsByNode.get(directoryNodeKey(directoryPath))?.size ?? 0,
          );

        addWeight(rawNodeWeights, directoryNodeKey(directoryPath), directoryWeight);
      });
    }

    rawNodeWeightsByContributor.set(contributorKey, rawNodeWeights);
  }

  return specializeContributorWeightMaps(rawNodeWeightsByContributor);
}

function specializeContributorWeightMaps(
  rawWeights: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const contributorTotals = new Map<string, number>();
  const nodeTotals = new Map<string, number>();
  let repoTotal = 0;

  for (const [contributorKey, weightsForContributor] of rawWeights.entries()) {
    let contributorTotal = 0;

    for (const [nodeKey, weight] of weightsForContributor.entries()) {
      if (weight <= 0) {
        continue;
      }

      contributorTotal += weight;
      nodeTotals.set(nodeKey, (nodeTotals.get(nodeKey) ?? 0) + weight);
      repoTotal += weight;
    }

    contributorTotals.set(contributorKey, contributorTotal);
  }

  if (repoTotal <= 0) {
    return new Map(
      [...rawWeights.keys()].map((contributorKey) => [contributorKey, new Map<string, number>()]),
    );
  }

  return new Map(
    [...rawWeights.entries()].map(([contributorKey, weightsForContributor]) => [
      contributorKey,
      new Map(
        [...weightsForContributor.entries()]
          .map(([nodeKey, weight]) => {
            const contributorTotal = contributorTotals.get(contributorKey) ?? 0;
            const nodeTotal = nodeTotals.get(nodeKey) ?? 0;

            if (weight <= 0 || contributorTotal <= 0 || nodeTotal <= 0) {
              return [nodeKey, 0] as const;
            }

            const contributorShare = weight / contributorTotal;
            const repoShare = nodeTotal / repoTotal;
            const specializationLift = Math.max(
              0,
              Math.log(
                (contributorShare + SPECIALIZATION_EPSILON) / (repoShare + SPECIALIZATION_EPSILON),
              ),
            );

            return [
              nodeKey,
              Math.log1p(weight) * (SPECIALIZATION_BASELINE + specializationLift),
            ] as const;
          })
          .filter(([, weight]) => weight > 0),
      ),
    ]),
  );
}

function sumContributorWeightMaps(
  contributorWeightMaps: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ReadonlyMap<string, number> {
  return new Map(
    [...contributorWeightMaps.entries()].map(([contributorKey, weightsForContributor]) => [
      contributorKey,
      [...weightsForContributor.values()].reduce((sum, weight) => sum + weight, 0),
    ]),
  );
}

function collectOverlapEntries(
  leftProfileWeights: ReadonlyMap<string, number>,
  rightProfileWeights: ReadonlyMap<string, number>,
  leftRecentActivityWeights: ReadonlyMap<string, number>,
  rightRecentActivityWeights: ReadonlyMap<string, number> | undefined,
): readonly OverlapEntry[] {
  const smallerProfileWeights =
    leftProfileWeights.size <= rightProfileWeights.size ? leftProfileWeights : rightProfileWeights;
  const largerProfileWeights =
    smallerProfileWeights === leftProfileWeights ? rightProfileWeights : leftProfileWeights;
  const overlapEntries: OverlapEntry[] = [];

  for (const [nodeKey, leftWeight] of smallerProfileWeights.entries()) {
    const rightWeight = largerProfileWeights.get(nodeKey);

    if (rightWeight === undefined) {
      continue;
    }

    overlapEntries.push({
      nodeKey,
      overlapWeight: Math.min(leftWeight, rightWeight),
      recentOverlapWeight: Math.min(
        leftRecentActivityWeights.get(nodeKey) ?? 0,
        rightRecentActivityWeights?.get(nodeKey) ?? 0,
      ),
    });
  }

  return overlapEntries;
}

function compareContributorRelationships(
  left: ContributorRelationship,
  right: ContributorRelationship,
): number {
  return (
    right.relationshipScore - left.relationshipScore ||
    right.recentOverlapWeight - left.recentOverlapWeight ||
    right.overlapWeight - left.overlapWeight ||
    right.precision - left.precision ||
    formatContributorIdentity(left.contributor).localeCompare(
      formatContributorIdentity(right.contributor),
    )
  );
}

function compareContributorSummaries(left: ContributorSummary, right: ContributorSummary): number {
  return (
    right.touchedCommitCount - left.touchedCommitCount ||
    right.recentCommitCount - left.recentCommitCount ||
    right.profileWeight - left.profileWeight ||
    right.touchedFileCount - left.touchedFileCount ||
    formatContributorIdentity(left.contributor).localeCompare(
      formatContributorIdentity(right.contributor),
    )
  );
}

function compareOverlapEntries(left: OverlapEntry, right: OverlapEntry): number {
  return (
    right.recentOverlapWeight - left.recentOverlapWeight ||
    right.overlapWeight - left.overlapWeight ||
    left.nodeKey.localeCompare(right.nodeKey)
  );
}

function resolveSelfContributor(
  rawIdentitiesByKey: ReadonlyMap<string, ContributorIdentity>,
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
      matchingRawKeys.add(contributor.key);
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

function canonicalizeContributor(
  contributor: ContributorIdentity,
  selfContributorRawKeys: ReadonlySet<string>,
  selfContributor?: ContributorIdentity,
): ContributorIdentity {
  return selfContributor && selfContributorRawKeys.has(contributor.key)
    ? selfContributor
    : contributor;
}

function collectTrackedTouchedPaths(
  touchedPaths: readonly string[],
  trackedPaths?: ReadonlySet<string>,
): readonly string[] {
  const uniqueTouchedPaths = new Set<string>();

  for (const touchedPath of touchedPaths) {
    const normalizedPath = touchedPath.trim();

    if (!normalizedPath || uniqueTouchedPaths.has(normalizedPath)) {
      continue;
    }

    if (trackedPaths && !trackedPaths.has(normalizedPath)) {
      continue;
    }

    uniqueTouchedPaths.add(normalizedPath);
  }

  return [...uniqueTouchedPaths];
}

function listAncestorDirectories(filePath: string): readonly string[] {
  const segments = filePath.split("/").filter(Boolean);

  if (segments.length <= 1) {
    return [];
  }

  const directories: string[] = [];

  for (let index = segments.length - 1; index >= 1; index -= 1) {
    const directoryPath = segments.slice(0, index).join("/");

    if (directoryPath) {
      directories.push(directoryPath);
    }
  }

  return directories;
}

function countSharedFiles(leftFiles: ReadonlySet<string>, rightFiles: ReadonlySet<string>): number {
  const smallerFiles = leftFiles.size <= rightFiles.size ? leftFiles : rightFiles;
  const largerFiles = smallerFiles === leftFiles ? rightFiles : leftFiles;
  let sharedFileCount = 0;

  for (const filePath of smallerFiles) {
    if (largerFiles.has(filePath)) {
      sharedFileCount += 1;
    }
  }

  return sharedFileCount;
}

function addContributorToNode(
  contributorsByNode: Map<string, Set<string>>,
  nodeKey: string,
  contributorKey: string,
): void {
  let contributorKeys = contributorsByNode.get(nodeKey);

  if (!contributorKeys) {
    contributorKeys = new Set<string>();
    contributorsByNode.set(nodeKey, contributorKeys);
  }

  contributorKeys.add(contributorKey);
}

function addWeight(weights: Map<string, number>, nodeKey: string, value: number): void {
  if (value <= 0) {
    return;
  }

  weights.set(nodeKey, (weights.get(nodeKey) ?? 0) + value);
}

function computeBulkPenalty(fileCount: number): number {
  return fileCount > 0 ? 1 / Math.pow(fileCount, BULK_COMMIT_EXPONENT) : 0;
}

function computeSpreadPenalty(
  touchedPaths: readonly string[],
  packageRootDirectories: ReadonlySet<string>,
): number {
  if (!touchedPaths.length) {
    return 0;
  }

  const packageRoots = new Set<string>();
  const topLevelDirectories = new Set<string>();

  for (const touchedPath of touchedPaths) {
    const packageRoot = findNearestPackageRoot(
      getRelativeDirectory(touchedPath),
      packageRootDirectories,
    );

    if (packageRoot !== undefined) {
      packageRoots.add(packageRoot);
    }

    topLevelDirectories.add(getTopLevelDirectory(touchedPath));
  }

  return 1 / (1 + Math.log1p(packageRoots.size) + 0.5 * Math.log1p(topLevelDirectories.size));
}

function computeNodeSpecificity(activeContributorCount: number): number {
  return 1 / Math.pow(Math.log2(2 + activeContributorCount), NODE_SPECIFICITY_EXPONENT);
}

function computeContributorActivityFactor(lastCommitAgeDays: number): number {
  if (!Number.isFinite(lastCommitAgeDays) || lastCommitAgeDays >= CONTRIBUTOR_ACTIVITY_SLOPE_DAYS) {
    return 0;
  }

  if (lastCommitAgeDays <= CONTRIBUTOR_ACTIVITY_FULL_WEIGHT_DAYS) {
    return 1;
  }

  const normalizedAge =
    (lastCommitAgeDays - CONTRIBUTOR_ACTIVITY_FULL_WEIGHT_DAYS) /
    (CONTRIBUTOR_ACTIVITY_SLOPE_DAYS - CONTRIBUTOR_ACTIVITY_FULL_WEIGHT_DAYS);

  return 0.5 * (1 + Math.cos(Math.PI * normalizedAge));
}

function computeFScore(beta: number, precision: number, recall: number): number {
  const betaSquared = beta * beta;
  const denominator = betaSquared * precision + recall;

  if (denominator <= 0) {
    return 0;
  }

  return ((1 + betaSquared) * precision * recall) / denominator;
}

function getAgeDays(nowMs: number, committedAtMs?: number): number {
  if (typeof committedAtMs !== "number" || !Number.isFinite(committedAtMs)) {
    return 0;
  }

  return Math.max(0, (nowMs - committedAtMs) / DAY_MS);
}

function profileRecencyWeight(ageDays: number): number {
  if (ageDays >= PROFILE_RECENCY_SLOPE_DAYS) {
    return PROFILE_RECENCY_FLOOR;
  }

  const normalizedAge = ageDays / PROFILE_RECENCY_SLOPE_DAYS;
  const cosineTaper = 0.5 * (1 + Math.cos(Math.PI * normalizedAge));

  return PROFILE_RECENCY_FLOOR + (1 - PROFILE_RECENCY_FLOOR) * cosineTaper;
}

function recentActivityWeight(ageDays: number): number {
  if (ageDays >= RECENT_ACTIVITY_WINDOW_DAYS) {
    return 0;
  }

  return 0.5 * (1 + Math.cos((Math.PI * ageDays) / RECENT_ACTIVITY_WINDOW_DAYS));
}

function fileNodeKey(filePath: string): string {
  return `${FILE_NODE_PREFIX}${filePath}`;
}

function directoryNodeKey(directoryPath: string): string {
  return `${DIRECTORY_NODE_PREFIX}${directoryPath}/`;
}

function formatNodeKey(nodeKey: string): string {
  if (nodeKey.startsWith(FILE_NODE_PREFIX)) {
    return nodeKey.slice(FILE_NODE_PREFIX.length);
  }

  if (nodeKey.startsWith(DIRECTORY_NODE_PREFIX)) {
    return nodeKey.slice(DIRECTORY_NODE_PREFIX.length);
  }

  return nodeKey;
}

function collectPackageRootsForGraph(
  touches: readonly ContributorTouch[],
  trackedPaths?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (trackedPaths?.size) {
    return collectPackageRootDirectories([...trackedPaths]);
  }

  return collectPackageRootDirectories(
    touches.flatMap((touch) => touch.touchedPaths.map((touchedPath) => touchedPath.trim())),
  );
}

function getRelativeDirectory(filePath: string): string {
  const directory = path.posix.dirname(filePath);

  return directory === "." ? "" : directory;
}

function getTopLevelDirectory(filePath: string): string {
  const [topLevelDirectory] = filePath.split("/", 1);

  return topLevelDirectory ?? "";
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
