import type { IconThemeData, IconThemeOverride } from "./types";

export function parseIconTheme(themeFileContent: Uint8Array): IconThemeData | undefined {
  const rawTheme = JSON.parse(Buffer.from(themeFileContent).toString("utf8")) as unknown;

  return isRecord(rawTheme) ? (rawTheme as IconThemeData) : undefined;
}

export function readIconDefinitionPaths(
  iconDefinitions: IconThemeData["iconDefinitions"],
): ReadonlyMap<string, string> {
  if (!isRecord(iconDefinitions)) {
    return new Map();
  }

  const normalizedDefinitions = new Map<string, string>();

  for (const [iconId, iconDefinition] of Object.entries(iconDefinitions)) {
    if (!isRecord(iconDefinition)) {
      continue;
    }

    const iconPath = normalizeOptionalString(iconDefinition["iconPath"]);

    if (iconPath) {
      normalizedDefinitions.set(iconId, iconPath);
    }
  }

  return normalizedDefinitions;
}

export function readThemeOverride(value: unknown): IconThemeOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    file: normalizeOptionalString(value["file"]),
    fileExtensions: readAssociationMap(value["fileExtensions"]),
    fileNames: readAssociationMap(value["fileNames"]),
  };
}

export function readAssociationMap(value: unknown): ReadonlyMap<string, string> {
  if (!isRecord(value)) {
    return new Map();
  }

  const associations = new Map<string, string>();

  for (const [key, iconId] of Object.entries(value)) {
    if (typeof iconId === "string") {
      associations.set(key.toLowerCase(), iconId);
    }
  }

  return associations;
}

export function findMatchingAssociation(
  associations: ReadonlyMap<string, string> | undefined,
  candidates: readonly string[],
): string | undefined {
  if (!associations?.size) {
    return undefined;
  }

  for (const candidate of candidates) {
    const iconId = associations.get(candidate);

    if (iconId) {
      return iconId;
    }
  }

  return undefined;
}

export function findMatchingAssociationInOverrides(
  overrides: readonly IconThemeOverride[],
  key: "fileNames" | "fileExtensions",
  candidates: readonly string[],
): string | undefined {
  for (const override of overrides) {
    const iconId = findMatchingAssociation(override[key], candidates);

    if (iconId) {
      return iconId;
    }
  }

  return undefined;
}

export function findFileIconOverride(overrides: readonly IconThemeOverride[]): string | undefined {
  for (const override of overrides) {
    if (override.file) {
      return override.file;
    }
  }

  return undefined;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
