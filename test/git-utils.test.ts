import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { loadWorkspaceFilePathsFromGit } from "../src/workspace/git-utils";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    const directory = tempDirectories.pop();

    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("loadWorkspaceFilePathsFromGit", () => {
  test("does not drop tracked files when ignored files are present", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "better-go-to-file-git-paths-"));
    tempDirectories.push(repoPath);

    await runGit(repoPath, ["init"]);
    await runGit(repoPath, ["config", "user.name", "Braden"]);
    await runGit(repoPath, ["config", "user.email", "braden@example.com"]);
    await writeRepoFile(repoPath, ".gitignore", "ignored/\n");
    await writeRepoFile(repoPath, "tracked/button.ts", "export const tracked = true;\n");
    await writeRepoFile(repoPath, "untracked/draft.ts", "export const draft = true;\n");
    await writeRepoFile(repoPath, "ignored/output.txt", "ignored\n");
    await runGit(repoPath, ["add", ".gitignore", "tracked/button.ts"]);
    await runGit(repoPath, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);

    const paths = await loadWorkspaceFilePathsFromGit(repoPath);

    expect(paths.includes("tracked/button.ts")).toBe(true);
    expect(paths.includes("untracked/draft.ts")).toBe(true);
    expect(paths.includes("ignored/output.txt")).toBe(true);
  });

  test("skips tracked symbolic links", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "better-go-to-file-git-paths-"));
    tempDirectories.push(repoPath);

    await runGit(repoPath, ["init"]);
    await runGit(repoPath, ["config", "user.name", "Braden"]);
    await runGit(repoPath, ["config", "user.email", "braden@example.com"]);
    await writeRepoFile(repoPath, "tracked/button.ts", "export const tracked = true;\n");
    await symlink("tracked/button.ts", path.join(repoPath, "tracked-link.ts"));
    await runGit(repoPath, ["add", "tracked/button.ts", "tracked-link.ts"]);
    await runGit(repoPath, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);

    const paths = await loadWorkspaceFilePathsFromGit(repoPath);

    expect(paths.includes("tracked/button.ts")).toBe(true);
    expect(paths.includes("tracked-link.ts")).toBe(false);
  });

  test("supports filtering to a workspace subfolder", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "better-go-to-file-git-paths-"));
    tempDirectories.push(repoPath);

    await runGit(repoPath, ["init"]);
    await runGit(repoPath, ["config", "user.name", "Braden"]);
    await runGit(repoPath, ["config", "user.email", "braden@example.com"]);
    await writeRepoFile(repoPath, "apps/ios/button.ts", "export const ios = true;\n");
    await writeRepoFile(repoPath, "apps/android/button.ts", "export const android = true;\n");
    await runGit(repoPath, ["add", "apps/ios/button.ts", "apps/android/button.ts"]);
    await runGit(repoPath, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);

    const paths = await loadWorkspaceFilePathsFromGit(repoPath, "apps/ios");

    expect(paths).toEqual(["apps/ios/button.ts"]);
  });
});

async function writeRepoFile(
  repoPath: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = path.join(repoPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: process.env,
  });
}
