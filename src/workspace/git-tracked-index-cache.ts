export const GIT_TRACKED_INDEX_CACHE_VERSION = 2;

export interface GitStateValidation {
  readonly headCommit?: string;
  readonly indexStamp?: string;
}

export function shouldReusePersistedGitState(
  cachedValidation: GitStateValidation | undefined,
  currentValidation: GitStateValidation,
): boolean {
  return (
    cachedValidation?.headCommit === currentValidation.headCommit &&
    cachedValidation?.indexStamp === currentValidation.indexStamp
  );
}
