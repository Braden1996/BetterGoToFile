import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { decayFrecencyScore, FrecencyStore, recordFrecencyAccess } from "../src/frecency-store";

const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    const directory = tempDirectories.pop();

    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("frecency math", () => {
  test("decays by half over one half-life", () => {
    const record = recordFrecencyAccess(undefined, 0, 1000, 4);

    expect(decayFrecencyScore(record, 1000, 1000)).toBeCloseTo(2, 5);
  });

  test("persists and reloads records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "better-go-to-file-"));
    const filePath = path.join(directory, "frecency.json");
    const store = new FrecencyStore(filePath, { halfLifeMs: 1000, flushDelayMs: 0 });
    const now = Date.now();

    tempDirectories.push(directory);

    await store.ready();
    store.recordOpen("src/config.ts", { now, weight: 2 });
    await store.flush();

    const reloaded = new FrecencyStore(filePath, { halfLifeMs: 1000, flushDelayMs: 0 });

    await reloaded.ready();

    const afterReload = Date.now();

    expect(reloaded.getCurrentScore("src/config.ts", afterReload)).toBeGreaterThan(1.9);
    expect(reloaded.getCurrentScore("src/config.ts", afterReload + 1000)).toBeLessThan(1.1);
    expect(reloaded.getCurrentScore("src/config.ts", afterReload + 1000)).toBeGreaterThan(0.9);

    reloaded.dispose();
    store.dispose();
  });
});
