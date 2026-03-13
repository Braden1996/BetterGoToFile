import { describe, expect, test } from "bun:test";
import {
  getScoringPresetValues,
  hasScoringPresetOverride,
  parseScoringPresetOverrideInput,
  resolveScoringPresetValues,
  sanitizeScoringPresetOverride,
} from "../src/config/scoring-presets";

describe("scoring presets", () => {
  test("uses the balanced preset as the ergonomic default", () => {
    const preset = getScoringPresetValues("balanced");

    expect(preset.frecencyHalfLifeDays).toBe(10);
    expect(preset.ranking.lexical.basenameExactScore).toBeGreaterThan(
      preset.ranking.lexical.basenamePrefixScore,
    );
    expect(preset.ranking.context.openBrowseBoost).toBeGreaterThan(
      preset.ranking.context.openQueryBoost,
    );
  });

  test("merges custom overrides on top of the selected preset", () => {
    const preset = resolveScoringPresetValues("exact", {
      frecencyHalfLifeDays: 9,
      visits: {
        explicitOpenWeight: 5,
      },
      ranking: {
        lexical: {
          basenameFuzzyBonus: 900,
        },
        context: {
          openQueryBoost: 120,
        },
      },
    });

    expect(preset.frecencyHalfLifeDays).toBe(9);
    expect(preset.visits.explicitOpenWeight).toBe(5);
    expect(preset.visits.implicitOpenWeight).toBe(1);
    expect(preset.ranking.lexical.basenameFuzzyBonus).toBe(900);
    expect(preset.ranking.context.openQueryBoost).toBe(120);
    expect(preset.ranking.context.openBrowseBoost).toBe(140);
  });

  test("sanitizes invalid override values away", () => {
    const override = sanitizeScoringPresetOverride({
      frecencyHalfLifeDays: 0,
      visits: {
        explicitOpenWeight: 3,
        editorDwellMs: "nope",
      },
      ranking: {
        lexical: {
          basenameExactScore: -5,
          pathFuzzyBonus: 1200,
        },
        context: {
          openBrowseBoost: Infinity,
        },
      },
    });

    expect(override).toEqual({
      frecencyHalfLifeDays: 1,
      visits: {
        explicitOpenWeight: 3,
      },
      ranking: {
        lexical: {
          basenameExactScore: 0,
          pathFuzzyBonus: 1200,
        },
      },
    });
  });

  test("parses custom preset overrides from a JSON string", () => {
    expect(
      parseScoringPresetOverrideInput(
        JSON.stringify({
          visits: {
            explicitOpenWeight: 3,
          },
          ranking: {
            lexical: {
              pathFuzzyBonus: 1200,
            },
          },
        }),
      ),
    ).toEqual({
      visits: {
        explicitOpenWeight: 3,
      },
      ranking: {
        lexical: {
          pathFuzzyBonus: 1200,
        },
      },
    });
  });

  test("treats blank or invalid custom preset input as disabled", () => {
    expect(hasScoringPresetOverride(parseScoringPresetOverrideInput(""))).toBe(false);
    expect(hasScoringPresetOverride(parseScoringPresetOverrideInput("{"))).toBe(false);
  });
});
