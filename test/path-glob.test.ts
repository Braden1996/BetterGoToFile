import { describe, expect, test } from "bun:test";
import { createPathGlobMatcher } from "../src/workspace/path-glob";

describe("path glob matcher", () => {
  test("matches root and nested files for recursive globs", () => {
    const matcher = createPathGlobMatcher("**/*");

    expect(matcher("package.json")).toBe(true);
    expect(matcher("src/app/activate.ts")).toBe(true);
  });

  test("supports brace alternatives within a segment", () => {
    const matcher = createPathGlobMatcher("src/**/*.{ts,tsx}");

    expect(matcher("src/app/activate.ts")).toBe(true);
    expect(matcher("src/app/view.tsx")).toBe(true);
    expect(matcher("src/app/view.js")).toBe(false);
  });

  test("supports single-character wildcards", () => {
    const matcher = createPathGlobMatcher("**/*.test.?s");

    expect(matcher("src/path-glob.test.ts")).toBe(true);
    expect(matcher("src/path-glob.test.js")).toBe(true);
    expect(matcher("src/path-glob.test.mjs")).toBe(false);
  });
});
