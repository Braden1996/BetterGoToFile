import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  numberParser,
  run,
  type CommandContext,
} from "@stricli/core";
import * as path from "node:path";
import {
  explainRepositoryCandidate,
  parseCustomPresetInput,
  searchRepository,
  type RepositoryContributorFilePrior,
  type RepositoryContributorState,
  type RepositoryFrecencyState,
  validateRepositoryPath,
} from "./scoring-debug";
import type { GitignoredVisibility } from "../src/config/schema";
import type { ScoringPresetId, ScoringPresetOverride } from "../src/config/scoring-presets";
import {
  formatContributorIdentity,
  type ContributorSelector,
} from "../src/workspace/contributor-relationship-model";

interface CliContext extends CommandContext {
  readonly cwd: string;
}

interface SharedFlags {
  readonly repo: string;
  readonly preset: ScoringPresetId;
  readonly customPreset?: ScoringPresetOverride;
  readonly activePath?: string;
  readonly openPath?: readonly string[];
  readonly gitignored: GitignoredVisibility;
  readonly contributorName?: string;
  readonly contributorEmail?: string;
  readonly frecencyFile?: string;
  readonly noFrecency: boolean;
}

interface SearchFlags extends SharedFlags {
  readonly limit: number;
  readonly debug: boolean;
}

interface ExplainFlags extends SharedFlags {
  readonly context: number;
}

const PRESETS = ["balanced", "exact", "recent", "nearby", "fuzzy"] as const;
const GITIGNORED_VISIBILITY = ["show", "auto", "hide"] as const;

const app = buildApplication(
  buildRouteMap({
    routes: {
      search: buildCommand<SearchFlags, [string], CliContext>({
        parameters: {
          flags: {
            repo: {
              kind: "parsed",
              brief: "Absolute or relative path to the repository to scan.",
              placeholder: "path",
              parse: async function (input) {
                return validateRepositoryPath(resolveFromCwd(this.cwd, input));
              },
            },
            preset: {
              kind: "enum",
              brief: "Scoring preset to apply.",
              values: PRESETS,
              default: "balanced",
            },
            customPreset: {
              kind: "parsed",
              brief: "JSON override layered on top of the selected preset.",
              placeholder: "json",
              optional: true,
              parse: async (input) => parseCustomPresetInput(input),
            },
            activePath: {
              kind: "parsed",
              brief: "Relative path to treat as the active editor context.",
              placeholder: "path",
              optional: true,
              parse: async (input) => input,
            },
            openPath: {
              kind: "parsed",
              brief: "Comma-separated relative paths to treat as open tabs.",
              placeholder: "paths",
              optional: true,
              variadic: ",",
              parse: async (input) => input,
            },
            gitignored: {
              kind: "enum",
              brief: "How gitignored files should be treated before ranking.",
              values: GITIGNORED_VISIBILITY,
              default: "auto",
            },
            contributorName: {
              kind: "parsed",
              brief: "Override the contributor name used for contributor-relationship priors.",
              placeholder: "name",
              optional: true,
              parse: async (input) => requireNonEmpty(input, "contributorName"),
            },
            contributorEmail: {
              kind: "parsed",
              brief: "Override the contributor email used for contributor-relationship priors.",
              placeholder: "email",
              optional: true,
              parse: async (input) => requireNonEmpty(input, "contributorEmail"),
            },
            frecencyFile: {
              kind: "parsed",
              brief: "Explicit path to a persisted Better Go To File frecency.json snapshot.",
              placeholder: "path",
              optional: true,
              parse: async function (input) {
                return path.resolve(this.cwd, requireNonEmpty(input, "frecencyFile"));
              },
            },
            noFrecency: {
              kind: "boolean",
              brief: "Disable persisted frecency loading for this run.",
              default: false,
            },
            limit: {
              kind: "parsed",
              brief: "Maximum number of ranked results to print.",
              placeholder: "count",
              default: "10",
              parse: async (input) => parsePositiveInteger(input, "limit", 1),
            },
            debug: {
              kind: "boolean",
              brief: "Include detailed score breakdown lines for each result.",
              default: false,
            },
          },
          aliases: {
            r: "repo",
            p: "preset",
            c: "customPreset",
            a: "activePath",
            o: "openPath",
            g: "gitignored",
            n: "contributorName",
            e: "contributorEmail",
            f: "frecencyFile",
            l: "limit",
            d: "debug",
          },
          positional: {
            kind: "tuple",
            parameters: [
              {
                brief: "Search query to rank against the repository index.",
                placeholder: "query",
                parse: async (input) => requireNonEmpty(input, "query"),
              },
            ],
          },
        },
        docs: {
          brief: "Rank query results for a local repository using Better Go To File scoring.",
          fullDescription:
            "Scans the target repository, applies the selected scoring preset, and prints the top ranked paths with auto-discovered frecency and contributor priors when local data is available.",
        },
        func: async function (flags, query) {
          const result = await searchRepository(
            {
              repoPath: flags.repo,
              query,
              preset: flags.preset,
              customPreset: flags.customPreset,
              activePath: flags.activePath,
              openPaths: flags.openPath,
              gitignoredVisibility: flags.gitignored,
              contributor: createContributorSelector(flags),
              frecencyFilePath: flags.frecencyFile,
              noFrecency: flags.noFrecency,
            },
            flags.limit,
          );

          writeSearchSummary(
            this,
            result.repoPath,
            result.query,
            result.preset,
            result.contributorState,
            result.frecencyState,
            result.results.length,
          );
          this.process.stdout.write(
            `Candidates: ${result.visibleCandidateCount}/${result.totalCandidateCount} visible\n`,
          );

          for (const ranked of result.results) {
            this.process.stdout.write(
              `${ranked.rank}. ${formatScore(ranked.total)} ${ranked.candidate.relativePath}\n`,
            );

            if (flags.debug) {
              this.process.stdout.write(`   ${ranked.debugDetail}\n`);

              if (ranked.contributorPrior) {
                this.process.stdout.write(
                  `   contributor ${formatContributorPrior(ranked.contributorPrior)}\n`,
                );
              }
            }
          }
        },
      }),
      explain: buildCommand<ExplainFlags, [string, string], CliContext>({
        parameters: {
          flags: {
            repo: {
              kind: "parsed",
              brief: "Absolute or relative path to the repository to scan.",
              placeholder: "path",
              parse: async function (input) {
                return validateRepositoryPath(resolveFromCwd(this.cwd, input));
              },
            },
            preset: {
              kind: "enum",
              brief: "Scoring preset to apply.",
              values: PRESETS,
              default: "balanced",
            },
            customPreset: {
              kind: "parsed",
              brief: "JSON override layered on top of the selected preset.",
              placeholder: "json",
              optional: true,
              parse: async (input) => parseCustomPresetInput(input),
            },
            activePath: {
              kind: "parsed",
              brief: "Relative path to treat as the active editor context.",
              placeholder: "path",
              optional: true,
              parse: async (input) => input,
            },
            openPath: {
              kind: "parsed",
              brief: "Comma-separated relative paths to treat as open tabs.",
              placeholder: "paths",
              optional: true,
              variadic: ",",
              parse: async (input) => input,
            },
            gitignored: {
              kind: "enum",
              brief: "How gitignored files should be treated before ranking.",
              values: GITIGNORED_VISIBILITY,
              default: "auto",
            },
            contributorName: {
              kind: "parsed",
              brief: "Override the contributor name used for contributor-relationship priors.",
              placeholder: "name",
              optional: true,
              parse: async (input) => requireNonEmpty(input, "contributorName"),
            },
            contributorEmail: {
              kind: "parsed",
              brief: "Override the contributor email used for contributor-relationship priors.",
              placeholder: "email",
              optional: true,
              parse: async (input) => requireNonEmpty(input, "contributorEmail"),
            },
            frecencyFile: {
              kind: "parsed",
              brief: "Explicit path to a persisted Better Go To File frecency.json snapshot.",
              placeholder: "path",
              optional: true,
              parse: async function (input) {
                return path.resolve(this.cwd, requireNonEmpty(input, "frecencyFile"));
              },
            },
            noFrecency: {
              kind: "boolean",
              brief: "Disable persisted frecency loading for this run.",
              default: false,
            },
            context: {
              kind: "parsed",
              brief: "How many neighboring ranked rows to print around the target match.",
              placeholder: "count",
              default: "2",
              parse: async (input) => parsePositiveInteger(input, "context", 0),
            },
          },
          aliases: {
            r: "repo",
            p: "preset",
            c: "customPreset",
            a: "activePath",
            o: "openPath",
            g: "gitignored",
            n: "contributorName",
            e: "contributorEmail",
            f: "frecencyFile",
            x: "context",
          },
          positional: {
            kind: "tuple",
            parameters: [
              {
                brief: "Search query to rank against the repository index.",
                placeholder: "query",
                parse: async (input) => requireNonEmpty(input, "query"),
              },
              {
                brief: "Relative or absolute file path to explain within the ranked results.",
                placeholder: "path",
                parse: async (input) => requireNonEmpty(input, "path"),
              },
            ],
          },
        },
        docs: {
          brief: "Explain why a specific path ranks where it does for a query.",
          fullDescription:
            "Finds the target path inside the full ranked set, prints its score breakdown including persisted frecency and contributor priors when available, and shows nearby neighbors for comparison.",
        },
        func: async function (flags, query, targetPath) {
          const result = await explainRepositoryCandidate({
            repoPath: flags.repo,
            query,
            targetPath,
            preset: flags.preset,
            customPreset: flags.customPreset,
            activePath: flags.activePath,
            openPaths: flags.openPath,
            gitignoredVisibility: flags.gitignored,
            contributor: createContributorSelector(flags),
            frecencyFilePath: flags.frecencyFile,
            noFrecency: flags.noFrecency,
            contextWindow: flags.context,
          });

          writeSearchSummary(
            this,
            result.repoPath,
            result.query,
            result.preset,
            result.contributorState,
            result.frecencyState,
            1,
          );
          this.process.stdout.write(
            `Candidates: ${result.visibleCandidateCount}/${result.totalCandidateCount} visible\n`,
          );

          if (!result.target) {
            this.process.stdout.write(`Target not found in ranked results: ${result.targetPath}\n`);

            if (result.results.length > 0) {
              this.process.stdout.write("Top matches:\n");

              for (const ranked of result.results) {
                this.process.stdout.write(
                  `${ranked.rank}. ${formatScore(ranked.total)} ${ranked.candidate.relativePath}\n`,
                );
              }
            }

            return;
          }

          this.process.stdout.write(
            `Target: #${result.target.rank} ${result.target.candidate.relativePath}\n`,
          );
          this.process.stdout.write(`Score: ${formatScore(result.target.total)}\n`);
          this.process.stdout.write(`State: ${result.target.gitTrackingState}\n`);
          if (result.target.contributorPrior) {
            this.process.stdout.write(
              `Contributor: ${formatContributorPrior(result.target.contributorPrior)}\n`,
            );
          }
          this.process.stdout.write(`${result.target.debugDetail}\n`);

          if (result.surroundingResults.length > 0) {
            this.process.stdout.write("Neighbors:\n");

            for (const ranked of result.surroundingResults) {
              this.process.stdout.write(
                `${ranked.rank}. ${formatScore(ranked.total)} ${ranked.candidate.relativePath}\n`,
              );
            }
          }
        },
      }),
    },
    docs: {
      brief: "Local scoring tools for Better Go To File.",
      fullDescription:
        "Use these commands to inspect ranking behavior against any repository on disk without opening the VS Code extension host.",
    },
  }),
  {
    name: "bgf-score",
  },
);

void main();

async function main(): Promise<void> {
  await run(app, process.argv.slice(2), {
    cwd: process.cwd(),
    process,
  });
}

function resolveFromCwd(cwd: string, input: string): string {
  return input ? path.resolve(cwd, input) : cwd;
}

function requireNonEmpty(input: string, label: string): string {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    throw new Error(`${label} must not be empty`);
  }

  return trimmedInput;
}

function parsePositiveInteger(input: string, label: string, minimum: number): number {
  const parsed = numberParser(input);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }

  return parsed;
}

function writeSearchSummary(
  context: CliContext,
  repoPath: string,
  query: string,
  preset: ScoringPresetId,
  contributorState: RepositoryContributorState,
  frecencyState: RepositoryFrecencyState,
  printedCount: number,
): void {
  context.process.stdout.write(`Repo: ${repoPath}\n`);
  context.process.stdout.write(`Query: ${query}\n`);
  context.process.stdout.write(`Preset: ${preset}\n`);
  writeContributorSummary(context, contributorState);
  writeFrecencySummary(context, frecencyState);
  context.process.stdout.write(`Printed: ${printedCount}\n`);
}

function writeContributorSummary(
  context: CliContext,
  contributorState: RepositoryContributorState,
): void {
  context.process.stdout.write(`Contributor prior: ${formatContributorStatus(contributorState)}\n`);

  const contributor = contributorState.currentContributor ?? contributorState.configuredContributor;

  if (!contributor) {
    return;
  }

  context.process.stdout.write(
    `Contributor identity: ${formatContributorLabel(contributor)} (${contributorState.selectionSource})\n`,
  );

  if (contributorState.status === "ready") {
    context.process.stdout.write(
      `Contributor graph: ${contributorState.teammateCount} teammates across ${contributorState.contributorCount} contributors\n`,
    );
  }
}

function formatContributorStatus(contributorState: RepositoryContributorState): string {
  switch (contributorState.status) {
    case "ready":
      return "ready";
    case "not-git":
      return "not a git repo";
    case "no-contributor":
      return "no configured contributor";
    case "no-history":
      return "no usable git history";
    case "no-current-contributor":
      return "contributor not found in git history";
  }
}

function writeFrecencySummary(context: CliContext, frecencyState: RepositoryFrecencyState): void {
  context.process.stdout.write(`Frecency: ${formatFrecencyStatus(frecencyState)}\n`);

  if (frecencyState.filePath) {
    context.process.stdout.write(`Frecency file: ${frecencyState.filePath}\n`);
  }

  if (frecencyState.workspacePath) {
    const editorLabel = frecencyState.editor ? ` (${frecencyState.editor})` : "";
    context.process.stdout.write(
      `Frecency workspace: ${frecencyState.workspacePath}${editorLabel}\n`,
    );
  }

  if (frecencyState.status === "ready") {
    context.process.stdout.write(`Frecency records: ${frecencyState.recordCount}\n`);
  }
}

function formatFrecencyStatus(frecencyState: RepositoryFrecencyState): string {
  switch (frecencyState.status) {
    case "ready":
      return `ready (${frecencyState.source})`;
    case "disabled":
      return "disabled";
    case "not-found":
      return "not found";
    case "invalid":
      return "invalid snapshot";
  }
}

function createContributorSelector(flags: SharedFlags): ContributorSelector | undefined {
  const contributorName = flags.contributorName?.trim();
  const contributorEmail = flags.contributorEmail?.trim();

  if (!contributorName && !contributorEmail) {
    return undefined;
  }

  return {
    name: contributorName,
    email: contributorEmail,
  };
}

function formatContributorLabel(contributor: ContributorSelector): string {
  if (contributor.name) {
    return formatContributorIdentity({
      key: contributor.email
        ? `email:${contributor.email.toLowerCase()}`
        : `name:${contributor.name.toLowerCase()}`,
      name: contributor.name,
      email: contributor.email,
    });
  }

  return contributor.email ?? "Unknown Contributor";
}

function formatContributorPrior(contributorPrior: RepositoryContributorFilePrior): string {
  return [
    `total ${formatPriorValue(contributorPrior.total)}`,
    `area ${formatPriorValue(contributorPrior.areaPrior)}`,
    `file ${formatPriorValue(contributorPrior.filePrior)}`,
    `team ${formatPriorValue(contributorPrior.teamPrior)}`,
    `owner ${formatPriorValue(contributorPrior.ownerPrior)}`,
  ].join(" | ");
}

function formatPriorValue(value: number): string {
  return value.toFixed(2);
}

function formatScore(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
