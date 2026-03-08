export type GitignoredVisibility = "show" | "auto" | "hide";

export function shouldIncludeGitignoredFile(
  query: string,
  gitignoredVisibility: GitignoredVisibility,
): boolean {
  if (gitignoredVisibility === "show") {
    return true;
  }

  if (gitignoredVisibility === "hide") {
    return false;
  }

  return isSpecificQuery(query);
}

export function isSpecificQuery(query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return false;
  }

  if (normalizedQuery.length >= 5) {
    return true;
  }

  if (/[./\\_-]/.test(normalizedQuery)) {
    return true;
  }

  return normalizedQuery.split(/\s+/).filter(Boolean).length >= 2;
}
