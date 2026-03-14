import { normalizePath } from "./path-normalization";

export interface GitStatusSnapshot {
  readonly headCommit?: string;
  readonly ignoredDirectoryPrefixes: readonly string[];
  readonly ignoredPaths: ReadonlySet<string>;
  readonly modifiedPaths: readonly string[];
  readonly stagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly upstreamRef?: string;
}

export function parseGitStatusSnapshot(stdout: string): GitStatusSnapshot {
  const stagedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const ignoredPaths = new Set<string>();
  const ignoredDirectoryPrefixes: string[] = [];
  let headCommit: string | undefined;
  let upstreamRef: string | undefined;
  const entries = stdout.split("\u0000");

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (!entry) {
      continue;
    }

    if (entry.startsWith("# branch.oid ")) {
      const branchOid = entry.slice("# branch.oid ".length).trim();

      headCommit = branchOid && branchOid !== "(initial)" ? branchOid : undefined;
      continue;
    }

    if (entry.startsWith("# branch.upstream ")) {
      upstreamRef = entry.slice("# branch.upstream ".length).trim() || undefined;
      continue;
    }

    if (entry[0] === "#") {
      continue;
    }

    if (entry.startsWith("? ")) {
      const untrackedPath = normalizePath(entry.slice(2));

      if (untrackedPath) {
        untrackedPaths.push(untrackedPath);
      }

      continue;
    }

    if (entry.startsWith("! ")) {
      const ignoredPath = normalizePath(entry.slice(2));

      if (!ignoredPath) {
        continue;
      }

      if (ignoredPath.endsWith("/")) {
        ignoredDirectoryPrefixes.push(ignoredPath);
      } else {
        ignoredPaths.add(ignoredPath);
      }

      continue;
    }

    if (entry.startsWith("1 ")) {
      const ordinaryEntry = parseOrdinaryChangedEntry(entry);

      if (ordinaryEntry) {
        collectChangedPath(ordinaryEntry, stagedPaths, modifiedPaths);
      }

      continue;
    }

    if (entry.startsWith("2 ")) {
      const renamedEntry = parseRenamedEntry(entry);

      if (renamedEntry) {
        collectChangedPath(renamedEntry, stagedPaths, modifiedPaths);
        index += 1;
      }

      continue;
    }

    if (entry.startsWith("u ")) {
      const conflictedEntry = parseUnmergedEntry(entry);

      if (conflictedEntry) {
        collectChangedPath(conflictedEntry, stagedPaths, modifiedPaths);
      }
    }
  }

  return {
    headCommit,
    ignoredDirectoryPrefixes,
    ignoredPaths,
    modifiedPaths,
    stagedPaths,
    untrackedPaths,
    upstreamRef,
  };
}

interface ChangedEntry {
  readonly path: string;
  readonly x: string;
  readonly y: string;
}

function parseOrdinaryChangedEntry(entry: string): ChangedEntry | undefined {
  const x = entry[2];
  const y = entry[3];
  const path = readTrailingField(entry, 8);

  return path ? { path, x, y } : undefined;
}

function parseRenamedEntry(entry: string): ChangedEntry | undefined {
  const x = entry[2];
  const y = entry[3];
  const path = readTrailingField(entry, 9);

  return path ? { path, x, y } : undefined;
}

function parseUnmergedEntry(entry: string): ChangedEntry | undefined {
  const x = entry[2];
  const y = entry[3];
  const path = readTrailingField(entry, 10);

  return path ? { path, x, y } : undefined;
}

function collectChangedPath(
  entry: ChangedEntry,
  stagedPaths: string[],
  modifiedPaths: string[],
): void {
  if (entry.x !== ".") {
    stagedPaths.push(entry.path);
  }

  if (entry.y !== ".") {
    modifiedPaths.push(entry.path);
  }
}

function readTrailingField(entry: string, fixedFieldCount: number): string | undefined {
  let start = 0;
  let remainingFields = fixedFieldCount;

  while (remainingFields > 0) {
    const spaceIndex = entry.indexOf(" ", start);

    if (spaceIndex === -1) {
      return undefined;
    }

    start = spaceIndex + 1;
    remainingFields -= 1;
  }

  const value = normalizePath(entry.slice(start));

  return value || undefined;
}
