import { describe, expect, test } from "bun:test";
import { createGitignoredIconDataUri } from "../src/icons/gitignored-icon";

const SVG_DATA_URI_PREFIX = "data:image/svg+xml;base64,";

describe("createGitignoredIconDataUri", () => {
  test("builds a generic ignored file icon when no base icon is provided", () => {
    const svg = decodeSvgDataUri(createGitignoredIconDataUri());

    expect(svg.includes('viewBox="0 0 16 16"')).toBe(true);
    expect(svg.includes('fill="#8A8A8A"')).toBe(true);
    expect(svg.includes('cx="12" cy="12" r="3"')).toBe(true);
  });

  test("wraps the base icon in an inline image layer", () => {
    const svg = decodeSvgDataUri(createGitignoredIconDataUri("data:image/png;base64,ZmFrZQ=="));

    expect(svg.includes("<image")).toBe(true);
    expect(svg.includes('href="data:image/png;base64,ZmFrZQ=="')).toBe(true);
    expect(svg.includes('stroke="#FFFFFF"')).toBe(true);
  });
});

function decodeSvgDataUri(dataUri: string): string {
  expect(dataUri.startsWith(SVG_DATA_URI_PREFIX)).toBe(true);

  return Buffer.from(dataUri.slice(SVG_DATA_URI_PREFIX.length), "base64").toString("utf8");
}
