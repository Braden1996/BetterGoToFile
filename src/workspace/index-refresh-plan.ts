export type WorkspaceIndexRefreshRequest =
  | { readonly kind: "full" }
  | {
      readonly kind: "partial";
      readonly workspaceFolderPath: string;
      readonly relativeDirectory: string;
    };

export function mergeWorkspaceIndexRefreshRequests(
  queue: readonly WorkspaceIndexRefreshRequest[],
  nextRequest: WorkspaceIndexRefreshRequest,
): WorkspaceIndexRefreshRequest[] {
  if (nextRequest.kind === "full") {
    return [nextRequest];
  }

  if (queue.some((request) => request.kind === "full")) {
    return [...queue];
  }

  const merged: WorkspaceIndexRefreshRequest[] = [];

  for (const request of queue) {
    if (request.kind !== "partial") {
      merged.push(request);
      continue;
    }

    if (request.workspaceFolderPath !== nextRequest.workspaceFolderPath) {
      merged.push(request);
      continue;
    }

    if (isSameOrAncestorDirectory(request.relativeDirectory, nextRequest.relativeDirectory)) {
      return [...queue];
    }

    if (isSameOrAncestorDirectory(nextRequest.relativeDirectory, request.relativeDirectory)) {
      continue;
    }

    merged.push(request);
  }

  merged.push(nextRequest);

  return merged;
}

function isSameOrAncestorDirectory(ancestor: string, descendant: string): boolean {
  return !ancestor || descendant === ancestor || descendant.startsWith(`${ancestor}/`);
}
