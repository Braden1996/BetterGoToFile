import { describe, expect, test } from "bun:test";
import { formatDebugScoreDetail } from "../src/search/search-score-detail";
import type { SearchScoreBreakdown } from "../src/search/search-ranking";

describe("formatDebugScoreDetail", () => {
  test("includes lexical, context, and git breakdowns", () => {
    const breakdown: SearchScoreBreakdown = {
      lexical: {
        total: 4_802,
        tokenMatches: [
          { token: "config", kind: "basenameExact", score: 5_590 },
          { token: "core", kind: "packagePrefix", score: 3_400 },
          { token: "index", kind: "pathBoundary", score: 2_800 },
        ],
        queryStructureBonus: 144,
        pathLengthPenalty: 18,
      },
      context: {
        total: 410,
        contributions: [
          { label: "tracked", score: 120 },
          { label: "open", score: 170 },
          { label: "same-dir", score: 110 },
          { label: "frecency", score: 10 },
        ],
      },
      gitPrior: {
        total: 290,
        rawPrior: 5,
        ambiguity: 0.63,
      },
    };

    expect(formatDebugScoreDetail(5_502, breakdown)).toBe(
      "score 5,502 | lex 4,802 [config base exact, core pkg prefix, +1 more matches, structure +144, length -18] | ctx +410 [tracked +120, open +170, same-dir +110, +1 more] | git +290 [prior 5, amb 0.63]",
    );
  });
});
