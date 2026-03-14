import { DEFAULT_BETTER_GO_TO_FILE_CONFIG, type GitignoredVisibility } from "../config/schema";

const EXACT_FILENAME_WITH_EXTENSION_QUERY = /^[^/\\\s]+\.[^/\\\s.]+$/;

export function shouldIncludeGitignoredFile(
  query: string,
  gitignored: GitignoredVisibility = DEFAULT_BETTER_GO_TO_FILE_CONFIG.gitignored,
): boolean {
  if (gitignored === "show") {
    return true;
  }

  if (gitignored === "hide") {
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
