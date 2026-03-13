import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { searchRepository } from "../scripts/scoring-debug";

const execFileAsync = promisify(execFile);

describe("scoring debug contributor priors", () => {
  const repoPaths: string[] = [];

  afterEach(async () => {
    for (const repoPath of repoPaths.splice(0, repoPaths.length)) {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  test("uses contributor relationship priors when ranking repository results", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "better-go-to-file-score-"));
    repoPaths.push(repoPath);
    await initializeRepository(repoPath);

    const withContributorPrior = await searchRepository(
      {
        repoPath,
        query: "button",
        preset: "balanced",
      },
      5,
    );
    const withoutContributorPrior = await searchRepository(
      {
        repoPath,
        query: "button",
        preset: "balanced",
        contributor: {
          email: "missing@example.com",
        },
      },
      5,
    );
    if (withContributorPrior.contributorState.status !== "ready") {
      throw new Error(
        `Expected contributor priors to be ready, got ${withContributorPrior.contributorState.status}`,
      );
    }

    expect(withContributorPrior.contributorState.currentContributor.email).toBe(
      "braden@example.com",
    );
    expect(withContributorPrior.results[0]?.candidate.relativePath).toBe(
      "packages/omega/src/controls/button.ts",
    );
    expect(withContributorPrior.results[0]?.contributorPrior?.teamPrior ?? 0).toBeGreaterThan(0);

    expect(withoutContributorPrior.contributorState.status).toBe("no-current-contributor");
    expect(withoutContributorPrior.results[0]?.candidate.relativePath).toBe(
      "packages/alpha/src/controls/button.ts",
    );
  });

  test("auto-discovers persisted frecency snapshots from workspace storage", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "better-go-to-file-score-"));
    repoPaths.push(repoPath);
    await writeRepoFile(repoPath, "alpha/button.ts", "export const alphaButton = 'alpha';\n");
    await writeRepoFile(repoPath, "omega/button.ts", "export const omegaButton = 'omega';\n");

    const workspaceStorageRoot = await mkdtemp(
      path.join(tmpdir(), "better-go-to-file-workspace-storage-"),
    );
    repoPaths.push(workspaceStorageRoot);
    const workspaceStoragePath = path.join(workspaceStorageRoot, "example-workspace");
    const frecencyFilePath = path.join(
      workspaceStoragePath,
      "local.better-go-to-file",
      "frecency.json",
    );
    await mkdir(path.dirname(frecencyFilePath), { recursive: true });
    await writeFile(
      path.join(workspaceStoragePath, "workspace.json"),
      JSON.stringify(
        {
          folder: pathToFileURL(repoPath).toString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      frecencyFilePath,
      JSON.stringify(
        {
          version: 1,
          halfLifeMs: 14 * 24 * 60 * 60 * 1000,
          records: {
            "omega/button.ts": {
              score: 4,
              referenceTime: Date.now(),
              lastAccessed: Date.now(),
              accessCount: 3,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await searchRepository(
      {
        repoPath,
        query: "button",
        preset: "balanced",
        workspaceStorageRoots: [workspaceStorageRoot],
      },
      5,
    );

    expect(result.frecencyState.status).toBe("ready");
    expect(result.frecencyState.filePath).toBe(frecencyFilePath);
    expect(result.results[0]?.candidate.relativePath).toBe("omega/button.ts");
  });
});

async function initializeRepository(repoPath: string): Promise<void> {
  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.name", "Braden"]);
  await runGit(repoPath, ["config", "user.email", "braden@example.com"]);

  await writeRepoFile(repoPath, "packages/alpha/package.json", '{ "name": "@repo/alpha" }\n');
  await writeRepoFile(repoPath, "packages/omega/package.json", '{ "name": "@repo/omega" }\n');
  await writeRepoFile(
    repoPath,
    "packages/omega/src/controls/current.ts",
    "export const current = 'current';\n",
  );
  await commitAll(
    repoPath,
    "Init",
    "init@example.com",
    "initial structure",
    "2026-03-01T09:00:00Z",
  );

  await writeRepoFile(
    repoPath,
    "packages/omega/src/controls/current.ts",
    "export const current = 'current area';\n",
  );
  await commitAll(
    repoPath,
    "Braden",
    "braden@example.com",
    "work in omega controls",
    "2026-03-02T09:00:00Z",
  );

  await writeRepoFile(
    repoPath,
    "packages/omega/src/controls/button.ts",
    "export const omegaButton = 'omega';\n",
  );
  await commitAll(repoPath, "Alex", "alex@example.com", "add omega button", "2026-03-03T09:00:00Z");

  await writeRepoFile(
    repoPath,
    "packages/alpha/src/controls/button.ts",
    "export const alphaButton = 'alpha';\n",
  );
  await commitAll(repoPath, "Pat", "pat@example.com", "add alpha button", "2026-03-04T09:00:00Z");
}

async function writeRepoFile(
  repoPath: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = path.join(repoPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function commitAll(
  repoPath: string,
  authorName: string,
  authorEmail: string,
  message: string,
  committedAt: string,
): Promise<void> {
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["-c", "commit.gpgsign=false", "commit", "-m", message], {
    GIT_AUTHOR_DATE: committedAt,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_NAME: authorName,
    GIT_COMMITTER_DATE: committedAt,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
  });
}

async function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}
