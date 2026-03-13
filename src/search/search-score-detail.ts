import type { SearchScoreBreakdown, TokenMatchKind } from "./search-ranking";

const MAX_MATCH_DETAILS = 2;
const MAX_CONTEXT_DETAILS = 3;

export function formatDebugScoreDetail(total: number, breakdown: SearchScoreBreakdown): string {
  const segments = [
    `score ${formatRounded(total)}`,
    `lex ${formatRounded(breakdown.lexical.total)}${formatLexicalDetails(breakdown)}`,
  ];

  if (breakdown.context.total !== 0 || breakdown.context.contributions.length > 0) {
    segments.push(`ctx ${formatSigned(breakdown.context.total)}${formatContextDetails(breakdown)}`);
  }

  if (breakdown.gitPrior.total !== 0 || breakdown.gitPrior.rawPrior > 0) {
    segments.push(
      `git ${formatSigned(breakdown.gitPrior.total)} [prior ${formatRounded(
        breakdown.gitPrior.rawPrior,
      )}, amb ${breakdown.gitPrior.ambiguity.toFixed(2)}]`,
    );
  }

  return segments.join(" | ");
}

function formatLexicalDetails(breakdown: SearchScoreBreakdown): string {
  const details = breakdown.lexical.tokenMatches
    .slice(0, MAX_MATCH_DETAILS)
    .map((match) => `${match.token} ${formatTokenMatchKind(match.kind)}`);

  const remainingMatches = breakdown.lexical.tokenMatches.length - MAX_MATCH_DETAILS;

  if (remainingMatches > 0) {
    details.push(`+${remainingMatches} more matches`);
  }

  if (breakdown.lexical.queryStructureBonus !== 0) {
    details.push(`structure ${formatSigned(breakdown.lexical.queryStructureBonus)}`);
  }

  if (Math.round(breakdown.lexical.pathLengthPenalty) !== 0) {
    details.push(`length ${formatSigned(-breakdown.lexical.pathLengthPenalty)}`);
  }

  return details.length > 0 ? ` [${details.join(", ")}]` : "";
}

function formatContextDetails(breakdown: SearchScoreBreakdown): string {
  const details = breakdown.context.contributions
    .slice(0, MAX_CONTEXT_DETAILS)
    .map((contribution) => `${contribution.label} ${formatSigned(contribution.score)}`);

  const remainingContributions = breakdown.context.contributions.length - MAX_CONTEXT_DETAILS;

  if (remainingContributions > 0) {
    details.push(`+${remainingContributions} more`);
  }

  return details.length > 0 ? ` [${details.join(", ")}]` : "";
}

function formatTokenMatchKind(kind: TokenMatchKind): string {
  switch (kind) {
    case "basenameExact":
      return "base exact";
    case "basenamePrefix":
      return "base prefix";
    case "basenameBoundary":
      return "base boundary";
    case "basenameSubstring":
      return "base substring";
    case "basenameFuzzy":
      return "base fuzzy";
    case "packageExact":
      return "pkg exact";
    case "packagePrefix":
      return "pkg prefix";
    case "packageBoundary":
      return "pkg boundary";
    case "packageSubstring":
      return "pkg substring";
    case "packageFuzzy":
      return "pkg fuzzy";
    case "pathExact":
      return "path exact";
    case "pathPrefix":
      return "path prefix";
    case "pathBoundary":
      return "path boundary";
    case "pathSubstring":
      return "path substring";
    case "pathFuzzy":
      return "path fuzzy";
  }
}

function formatRounded(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);

  return `${rounded >= 0 ? "+" : "-"}${Math.abs(rounded).toLocaleString("en-US")}`;
}
