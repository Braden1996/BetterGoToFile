export type GitRefreshKind = "full" | "overlay";

export interface GitRefreshRequest {
  readonly kind: GitRefreshKind;
  readonly workspaceFolderPaths?: readonly string[];
}

export function mergeGitRefreshRequests(
  current: GitRefreshRequest | undefined,
  next: GitRefreshRequest,
): GitRefreshRequest {
  if (!current) {
    return next;
  }

  const kind = current.kind === "full" || next.kind === "full" ? "full" : "overlay";

  if (!current.workspaceFolderPaths || !next.workspaceFolderPaths) {
    return { kind };
  }

  return {
    kind,
    workspaceFolderPaths: [
      ...new Set([...current.workspaceFolderPaths, ...next.workspaceFolderPaths]),
    ],
  };
}
