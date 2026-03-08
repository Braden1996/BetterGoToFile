import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { normalizePath } from "./workspace-path";

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
