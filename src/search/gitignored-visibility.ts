import {
  DEFAULT_BETTER_GO_TO_FILE_CONFIG,
  type GitignoredConfig,
  type GitignoredVisibility,
} from "../config/schema";

const EXACT_FILENAME_WITH_EXTENSION_QUERY = /^[^/\\\s]+\.[^/\\\s.]+$/;

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

  return isSpecificQuery(query);
}

export function isSpecificQuery(query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return false;
  }

  return EXACT_FILENAME_WITH_EXTENSION_QUERY.test(normalizedQuery);
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
