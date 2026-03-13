import * as path from "node:path";

export function normalizeDirectory(value: string): string {
  return value === "." ? "" : normalizePath(value);
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}
