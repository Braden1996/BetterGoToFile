import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FrecencyRecord {
  readonly score: number;
  readonly referenceTime: number;
  readonly lastAccessed: number;
  readonly accessCount: number;
}

interface FrecencySnapshot {
  readonly version: 1;
  readonly halfLifeMs: number;
  readonly records: Record<string, FrecencyRecord>;
}

export interface FrecencyStoreOptions {
  readonly halfLifeMs?: number;
  readonly flushDelayMs?: number;
  readonly maxRecords?: number;
}

export interface RecordOpenOptions {
  readonly now?: number;
  readonly weight?: number;
}

const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_DELAY_MS = 1500;
const DEFAULT_MAX_RECORDS = 20000;
const MIN_PERSISTED_SCORE = 0.05;

export class FrecencyStore {
  private readonly halfLifeMs: number;
  private readonly flushDelayMs: number;
  private readonly maxRecords: number;
  private readonly records = new Map<string, FrecencyRecord>();
  private readonly readyPromise: Promise<void>;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(
    private readonly filePath?: string,
    options: FrecencyStoreOptions = {},
  ) {
    this.halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.readyPromise = this.load();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  getCurrentScore(relativePath: string, now = Date.now()): number {
    const record = this.records.get(relativePath);

    if (!record) {
      return 0;
    }

    return decayFrecencyScore(record, now, this.halfLifeMs);
  }

  recordOpen(relativePath: string, options: RecordOpenOptions = {}): void {
    const now = options.now ?? Date.now();
    const weight = options.weight ?? 1;
    const existing = this.records.get(relativePath);
    const nextRecord = recordFrecencyAccess(existing, now, this.halfLifeMs, weight);

    this.records.set(relativePath, nextRecord);
    this.dirty = true;
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    await this.ready();

    if (!this.filePath || !this.dirty) {
      return;
    }

    const now = Date.now();
    const snapshot = this.createSnapshot(now);

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");

    this.dirty = false;
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    void this.flush();
  }

  private async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }

    try {
      const contents = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as FrecencySnapshot;

      if (!isSnapshot(parsed)) {
        return;
      }

      this.records.clear();

      for (const [relativePath, record] of Object.entries(parsed.records)) {
        if (isRecord(record)) {
          this.records.set(relativePath, record);
        }
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private scheduleFlush(): void {
    if (!this.filePath) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushDelayMs);
  }

  private createSnapshot(now: number): FrecencySnapshot {
    const scoredEntries = [...this.records.entries()]
      .map(([relativePath, record]) => ({
        relativePath,
        record,
        currentScore: decayFrecencyScore(record, now, this.halfLifeMs),
      }))
      .filter(
        ({ currentScore, record }) =>
          currentScore >= MIN_PERSISTED_SCORE || now - record.lastAccessed < this.halfLifeMs * 4,
      )
      .sort((left, right) => right.currentScore - left.currentScore)
      .slice(0, this.maxRecords);

    const records = Object.fromEntries(
      scoredEntries.map(({ relativePath, record, currentScore }) => [
        relativePath,
        {
          score: currentScore,
          referenceTime: now,
          lastAccessed: record.lastAccessed,
          accessCount: record.accessCount,
        } satisfies FrecencyRecord,
      ]),
    );

    return {
      version: 1,
      halfLifeMs: this.halfLifeMs,
      records,
    };
  }
}

export function decayFrecencyScore(
  record: FrecencyRecord,
  now: number,
  halfLifeMs: number,
): number {
  if (record.score <= 0) {
    return 0;
  }

  return record.score * Math.pow(0.5, (now - record.referenceTime) / halfLifeMs);
}

export function recordFrecencyAccess(
  existing: FrecencyRecord | undefined,
  now: number,
  halfLifeMs: number,
  weight: number,
): FrecencyRecord {
  const currentScore = existing ? decayFrecencyScore(existing, now, halfLifeMs) : 0;

  return {
    score: currentScore + weight,
    referenceTime: now,
    lastAccessed: now,
    accessCount: (existing?.accessCount ?? 0) + 1,
  };
}

function isSnapshot(value: unknown): value is FrecencySnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<FrecencySnapshot>;

  return (
    snapshot.version === 1 && typeof snapshot.halfLifeMs === "number" && Boolean(snapshot.records)
  );
}

function isRecord(value: unknown): value is FrecencyRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<FrecencyRecord>;

  return (
    typeof record.score === "number" &&
    typeof record.referenceTime === "number" &&
    typeof record.lastAccessed === "number" &&
    typeof record.accessCount === "number"
  );
}
