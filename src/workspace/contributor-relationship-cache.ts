import type { ContributorSelector } from "./contributor-relationship-model";

export const CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION = 7;

export function shouldRestoreCachedContributorState(
  cachedValue: {
    readonly configuredContributor?: ContributorSelector;
    readonly headCommit: string;
    readonly indexStamp?: string;
    readonly version: number;
  },
  expected: {
    readonly configuredContributor?: ContributorSelector;
    readonly headCommit?: string;
    readonly indexStamp?: string;
  },
): boolean {
  return (
    cachedValue.version === CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION &&
    cachedValue.headCommit === expected.headCommit &&
    cachedValue.indexStamp === expected.indexStamp &&
    createCacheContributorKey(cachedValue.configuredContributor) ===
      createCacheContributorKey(expected.configuredContributor)
  );
}

function createCacheContributorKey(contributor?: ContributorSelector): string {
  const normalizedName = contributor?.name?.trim().toLowerCase() ?? "";
  const normalizedEmail = contributor?.email?.trim().toLowerCase() ?? "";

  return `${normalizedName}\u001f${normalizedEmail}`;
}
