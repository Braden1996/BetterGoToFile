import {
  DEFAULT_BETTER_GO_TO_FILE_CONFIG,
  type GitignoredAutoConfig,
  type GitignoredConfig,
  type GitignoredVisibility,
} from "../config/schema";

export function shouldIncludeGitignoredFile(
  query: string,
  gitignored: GitignoredVisibility | GitignoredConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.gitignored,
): boolean {
  const config = normalizeGitignoredConfig(gitignored);

  if (config.visibility === "show") {
    return true;
  }

  if (config.visibility === "hide") {
    return false;
  }

  return isSpecificQuery(query, config.auto);
}

export function isSpecificQuery(
  query: string,
  auto: GitignoredAutoConfig = DEFAULT_BETTER_GO_TO_FILE_CONFIG.gitignored.auto,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return false;
  }

  if (normalizedQuery.length >= auto.minQueryLength) {
    return true;
  }

  if (auto.revealOnPathSeparator && /[./\\]/.test(normalizedQuery)) {
    return true;
  }

  return normalizedQuery.split(/\s+/).filter(Boolean).length >= auto.minTokenCount;
}

function normalizeGitignoredConfig(
  gitignored: GitignoredVisibility | GitignoredConfig,
): GitignoredConfig {
  if (typeof gitignored === "string") {
    return {
      visibility: gitignored,
      auto: DEFAULT_BETTER_GO_TO_FILE_CONFIG.gitignored.auto,
    };
  }

  return gitignored;
}
