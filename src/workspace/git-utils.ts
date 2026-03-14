import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseGitStatusSnapshot, type GitStatusSnapshot } from "./git-status-snapshot";
import { normalizePath } from "./path-normalization";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export async function resolveRepoRoot(cwd: string): Promise<string> {
  return normalizeFsPath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
}

export async function loadTrackedPaths(repoRootPath: string): Promise<ReadonlySet<string>> {
  const stdout = await runGit(repoRootPath, ["ls-files", "-z", "--cached"]);
  const trackedPaths = new Set<string>();

  for (const entry of stdout.split("\u0000")) {
    if (!entry) {
      continue;
    }

    trackedPaths.add(normalizePath(entry));
  }

  return trackedPaths;
}

export async function loadWorkspaceFilePathsFromGit(
  repoRootPath: string,
  repoRelativeFolderPath = "",
): Promise<readonly string[]> {
  const pathspecArgs = repoRelativeFolderPath ? ["--", repoRelativeFolderPath] : [];
  const [trackedPaths, untrackedPaths, ignoredPaths] = await Promise.all([
    loadTrackedGitPaths(repoRootPath, pathspecArgs),
    loadNulSeparatedGitPaths(
      repoRootPath,
      ["ls-files", "-z", "--others", "--exclude-standard", "--full-name"],
      pathspecArgs,
    ),
    loadNulSeparatedGitPaths(
      repoRootPath,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--full-name"],
      pathspecArgs,
    ),
  ]);
  const combinedPaths = new Set<string>();

  for (const relativePath of trackedPaths) {
    combinedPaths.add(relativePath);
  }

  for (const relativePath of untrackedPaths) {
    combinedPaths.add(relativePath);
  }

  for (const relativePath of ignoredPaths) {
    combinedPaths.add(relativePath);
  }

  return [...combinedPaths];
}

export async function loadGitStatusSnapshot(repoRootPath: string): Promise<GitStatusSnapshot> {
  return parseGitStatusSnapshot(
    await runGit(repoRootPath, [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--find-renames",
      "--ignored=matching",
      "--untracked-files=all",
    ]),
  );
}

export async function loadGitIndexStamp(repoRootPath: string): Promise<string | undefined> {
  try {
    const rawIndexPath = (await runGit(repoRootPath, ["rev-parse", "--git-path", "index"])).trim();
    const indexPath = path.isAbsolute(rawIndexPath)
      ? rawIndexPath
      : path.resolve(repoRootPath, rawIndexPath);
    const indexStats = await stat(indexPath);

    return `${indexStats.size}:${Math.trunc(indexStats.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  return stdout;
}

export function normalizeFsPath(value: string): string {
  return normalizePath(path.resolve(value));
}

async function loadNulSeparatedGitPaths(
  cwd: string,
  args: readonly string[],
  pathspecArgs: readonly string[] = [],
): Promise<readonly string[]> {
  const stdout = await runGit(cwd, [...args, ...pathspecArgs]);
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of stdout.split("\u0000")) {
    if (!entry) {
      continue;
    }

    const normalizedPath = normalizePath(entry);

    if (!normalizedPath || seenPaths.has(normalizedPath)) {
      continue;
    }

    seenPaths.add(normalizedPath);
    paths.push(normalizedPath);
  }

  return paths;
}

async function loadTrackedGitPaths(
  cwd: string,
  pathspecArgs: readonly string[] = [],
): Promise<readonly string[]> {
  const stdout = await runGit(cwd, [
    "ls-files",
    "-z",
    "--cached",
    "--full-name",
    "--stage",
    ...pathspecArgs,
  ]);
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of stdout.split("\u0000")) {
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf("\t");

    if (separatorIndex === -1) {
      continue;
    }

    const metadata = entry.slice(0, separatorIndex);
    const relativePath = normalizePath(entry.slice(separatorIndex + 1));
    const mode = metadata.split(" ", 1)[0];

    if (!relativePath || seenPaths.has(relativePath) || mode === "120000") {
      continue;
    }

    seenPaths.add(relativePath);
    paths.push(relativePath);
  }

  return paths;
}
