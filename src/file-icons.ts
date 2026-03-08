import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileEntry } from "./file-entry";

interface IconThemeContribution {
  readonly id: string;
  readonly path: string;
}

interface IconThemeData {
  readonly iconDefinitions?: Record<string, IconDefinition>;
  readonly file?: string;
  readonly fileExtensions?: Record<string, string>;
  readonly fileNames?: Record<string, string>;
  readonly light?: IconThemeOverrideData;
  readonly highContrast?: IconThemeOverrideData;
}

interface IconThemeOverrideData {
  readonly file?: string;
  readonly fileExtensions?: Record<string, string>;
  readonly fileNames?: Record<string, string>;
}

interface IconDefinition {
  readonly iconPath?: string;
}

interface IconThemeOverride {
  readonly file?: string;
  readonly fileExtensions: ReadonlyMap<string, string>;
  readonly fileNames: ReadonlyMap<string, string>;
}

export interface FileIconResolver {
  resolve(entry: FileEntry): vscode.IconPath | undefined;
  describe(entry: FileEntry): string;
}

export async function loadFileIconResolver(
  log?: (message: string) => void,
): Promise<FileIconResolver | undefined> {
  let themeId: string | undefined;

  try {
    themeId = vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
    log?.(`workbench.iconTheme=${themeId ?? "<unset>"}`);

    if (!themeId) {
      log?.("No active file icon theme is configured.");
      return undefined;
    }

    const contribution = findIconThemeContribution(themeId);

    if (!contribution) {
      log?.(`No installed extension contributes icon theme '${themeId}'.`);
      return undefined;
    }

    const themeUri = await resolveIconThemeUri(
      contribution.extension,
      contribution.iconTheme.path,
      log,
    );
    log?.(
      `Using icon theme '${themeId}' from ${contribution.extension.id} at ${themeUri.toString(true)}`,
    );

    const themeFileContent = await vscode.workspace.fs.readFile(themeUri);
    const parsedTheme = parseIconTheme(themeFileContent);

    if (!parsedTheme) {
      log?.(`Theme file '${themeUri.toString(true)}' did not parse as an icon theme.`);
      return undefined;
    }

    log?.(`Loaded icon theme '${themeId}' successfully.`);
    return new ConfiguredFileIconResolver(
      themeUri,
      parsedTheme,
      vscode.window.activeColorTheme.kind,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.(`Failed to load icon theme '${themeId ?? "<unset>"}': ${message}`);

    return undefined;
  }
}

class ConfiguredFileIconResolver implements FileIconResolver {
  private readonly defaultFileIconId?: string;
  private readonly iconDefinitionPaths: ReadonlyMap<string, string>;
  private readonly fileExtensions: ReadonlyMap<string, string>;
  private readonly fileNames: ReadonlyMap<string, string>;
  private readonly lightOverride?: IconThemeOverride;
  private readonly highContrastOverride?: IconThemeOverride;
  private readonly iconPathCache = new Map<string, vscode.IconPath | null>();

  constructor(
    private readonly themeUri: vscode.Uri,
    themeData: IconThemeData,
    private readonly colorThemeKind: vscode.ColorThemeKind,
  ) {
    this.defaultFileIconId = normalizeOptionalString(themeData.file);
    this.iconDefinitionPaths = readIconDefinitionPaths(themeData.iconDefinitions);
    this.fileExtensions = readAssociationMap(themeData.fileExtensions);
    this.fileNames = readAssociationMap(themeData.fileNames);
    this.lightOverride = readThemeOverride(themeData.light);
    this.highContrastOverride = readThemeOverride(themeData.highContrast);
  }

  resolve(entry: FileEntry): vscode.IconPath | undefined {
    const iconId = this.resolveIconId(entry);

    if (!iconId) {
      return undefined;
    }

    return this.getIconPath(iconId);
  }

  describe(entry: FileEntry): string {
    const iconId = this.resolveIconId(entry);

    if (!iconId) {
      return `${entry.relativePath}: no icon match, falling back`;
    }

    const iconDefinitionPath = this.iconDefinitionPaths.get(iconId);
    const iconPath = this.getIconPath(iconId);

    return [
      `path=${entry.relativePath}`,
      `iconId=${iconId}`,
      `definition=${iconDefinitionPath ?? "<missing>"}`,
      `customIcon=${iconPath ? "yes" : "no"}`,
    ].join(", ");
  }

  private resolveIconId(entry: FileEntry): string | undefined {
    const fileNameCandidates = buildFileNameCandidates(entry);
    const extensionCandidates = buildExtensionCandidates(entry);

    return (
      findMatchingAssociationInOverrides(
        this.getActiveOverrides(),
        "fileNames",
        fileNameCandidates,
      ) ??
      findMatchingAssociation(this.fileNames, fileNameCandidates) ??
      findMatchingAssociationInOverrides(
        this.getActiveOverrides(),
        "fileExtensions",
        extensionCandidates,
      ) ??
      findMatchingAssociation(this.fileExtensions, extensionCandidates) ??
      findFileIconOverride(this.getActiveOverrides()) ??
      this.defaultFileIconId
    );
  }

  private getActiveOverrides(): readonly IconThemeOverride[] {
    if (
      this.colorThemeKind === vscode.ColorThemeKind.HighContrast ||
      this.colorThemeKind === vscode.ColorThemeKind.HighContrastLight
    ) {
      return [this.highContrastOverride, this.lightOverride].filter(isDefined);
    }

    if (this.colorThemeKind === vscode.ColorThemeKind.Light) {
      return [this.lightOverride].filter(isDefined);
    }

    return [];
  }

  private getIconPath(iconId: string): vscode.IconPath | undefined {
    const cachedIconPath = this.iconPathCache.get(iconId);

    if (cachedIconPath !== undefined) {
      return cachedIconPath ?? undefined;
    }

    const iconDefinitionPath = this.iconDefinitionPaths.get(iconId);

    if (!iconDefinitionPath) {
      this.iconPathCache.set(iconId, null);
      return undefined;
    }

    const iconUri = resolveRelativeUriFromFile(this.themeUri, iconDefinitionPath);
    const iconPath = toInlineIconPath(iconUri);

    this.iconPathCache.set(iconId, iconPath ?? null);

    return iconPath;
  }
}

function findIconThemeContribution(
  themeId: string,
): { extension: vscode.Extension<unknown>; iconTheme: IconThemeContribution } | undefined {
  for (const extension of vscode.extensions.all) {
    for (const iconTheme of getIconThemeContributions(extension.packageJSON)) {
      if (iconTheme.id === themeId) {
        return { extension, iconTheme };
      }
    }
  }

  return undefined;
}

function getIconThemeContributions(packageJson: unknown): readonly IconThemeContribution[] {
  if (!isRecord(packageJson)) {
    return [];
  }

  const contributes = packageJson["contributes"];

  if (!isRecord(contributes)) {
    return [];
  }

  const iconThemes = contributes["iconThemes"];

  if (!Array.isArray(iconThemes)) {
    return [];
  }

  return iconThemes.flatMap((iconTheme): IconThemeContribution[] => {
    if (!isRecord(iconTheme)) {
      return [];
    }

    const id = iconTheme["id"];
    const iconThemePath = iconTheme["path"];

    if (typeof id !== "string" || typeof iconThemePath !== "string") {
      return [];
    }

    return [{ id, path: iconThemePath }];
  });
}

function parseIconTheme(themeFileContent: Uint8Array): IconThemeData | undefined {
  const rawTheme = JSON.parse(Buffer.from(themeFileContent).toString("utf8")) as unknown;

  return isRecord(rawTheme) ? (rawTheme as IconThemeData) : undefined;
}

async function resolveIconThemeUri(
  extension: vscode.Extension<unknown>,
  relativePath: string,
  log?: (message: string) => void,
): Promise<vscode.Uri> {
  const candidateRoots = await getExtensionRootCandidates(extension);

  for (const root of candidateRoots) {
    const candidateThemeUri = resolveRelativeUriFromDirectory(root, relativePath);

    if (await fileExists(candidateThemeUri)) {
      if (root.toString() !== extension.extensionUri.toString()) {
        log?.(`Recovered extension root for ${extension.id} at ${root.toString(true)}`);
      }

      return candidateThemeUri;
    }
  }

  return resolveRelativeUriFromDirectory(extension.extensionUri, relativePath);
}

async function getExtensionRootCandidates(
  extension: vscode.Extension<unknown>,
): Promise<vscode.Uri[]> {
  const candidates = new Map<string, vscode.Uri>();
  const pushCandidate = (candidate: vscode.Uri | undefined): void => {
    if (!candidate) {
      return;
    }

    candidates.set(candidate.toString(), candidate);
  };

  pushCandidate(extension.extensionUri);

  if (extension.extensionUri.scheme === "file") {
    pushCandidate(vscode.Uri.file(extension.extensionPath));

    const currentRootMatches = await findMatchingExtensionDirectories(
      extension.extensionUri,
      extension,
    );

    for (const match of currentRootMatches) {
      pushCandidate(match);
    }

    const parentDirectory = path.dirname(extension.extensionUri.fsPath);

    if (parentDirectory && parentDirectory !== extension.extensionUri.fsPath) {
      const siblingMatches = await findMatchingExtensionDirectories(
        vscode.Uri.file(parentDirectory),
        extension,
      );

      for (const match of siblingMatches) {
        pushCandidate(match);
      }
    }
  }

  return [...candidates.values()];
}

async function findMatchingExtensionDirectories(
  parentDirectory: vscode.Uri,
  extension: vscode.Extension<unknown>,
): Promise<vscode.Uri[]> {
  if (parentDirectory.scheme !== "file") {
    return [];
  }

  try {
    const directoryEntries = await vscode.workspace.fs.readDirectory(parentDirectory);
    const prefixes = buildExtensionDirectoryPrefixes(extension);
    const matches: vscode.Uri[] = [];

    for (const [name, fileType] of directoryEntries) {
      if (fileType !== vscode.FileType.Directory) {
        continue;
      }

      const normalizedName = name.toLowerCase();

      if (
        prefixes.some(
          (prefix) => normalizedName === prefix || normalizedName.startsWith(`${prefix}-`),
        )
      ) {
        matches.push(vscode.Uri.joinPath(parentDirectory, name));
      }
    }

    matches.sort(
      (left, right) =>
        scoreExtensionDirectory(right, extension) - scoreExtensionDirectory(left, extension),
    );

    return matches;
  } catch {
    return [];
  }
}

function buildExtensionDirectoryPrefixes(extension: vscode.Extension<unknown>): string[] {
  const prefixes = new Set<string>();

  if (extension.id) {
    prefixes.add(extension.id.toLowerCase());
  }

  const packageJson = extension.packageJSON;

  if (isRecord(packageJson)) {
    const publisher = normalizeOptionalString(packageJson["publisher"])?.toLowerCase();
    const name = normalizeOptionalString(packageJson["name"])?.toLowerCase();
    const version = normalizeOptionalString(packageJson["version"])?.toLowerCase();

    if (publisher && name) {
      prefixes.add(`${publisher}.${name}`);

      if (version) {
        prefixes.add(`${publisher}.${name}-${version}`);
      }
    }
  }

  return [...prefixes];
}

function scoreExtensionDirectory(
  directory: vscode.Uri,
  extension: vscode.Extension<unknown>,
): number {
  if (directory.scheme !== "file") {
    return 0;
  }

  const directoryName = path.basename(directory.fsPath).toLowerCase();
  let score = 0;

  if (directoryName === extension.id.toLowerCase()) {
    score += 4;
  }

  if (directoryName.startsWith(`${extension.id.toLowerCase()}-`)) {
    score += 3;
  }

  const packageJson = extension.packageJSON;

  if (isRecord(packageJson)) {
    const publisher = normalizeOptionalString(packageJson["publisher"])?.toLowerCase();
    const name = normalizeOptionalString(packageJson["name"])?.toLowerCase();
    const version = normalizeOptionalString(packageJson["version"])?.toLowerCase();

    if (publisher && name) {
      const packagePrefix = `${publisher}.${name}`;

      if (directoryName === packagePrefix) {
        score += 2;
      }

      if (directoryName.startsWith(`${packagePrefix}-`)) {
        score += 2;
      }

      if (version && directoryName.includes(`-${version}`)) {
        score += 2;
      }
    }
  }

  return score;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function readIconDefinitionPaths(
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

function readThemeOverride(value: unknown): IconThemeOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    file: normalizeOptionalString(value["file"]),
    fileExtensions: readAssociationMap(value["fileExtensions"]),
    fileNames: readAssociationMap(value["fileNames"]),
  };
}

function readAssociationMap(value: unknown): ReadonlyMap<string, string> {
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

function findMatchingAssociation(
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

function findMatchingAssociationInOverrides(
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

function findFileIconOverride(overrides: readonly IconThemeOverride[]): string | undefined {
  for (const override of overrides) {
    if (override.file) {
      return override.file;
    }
  }

  return undefined;
}

function buildFileNameCandidates(entry: FileEntry): string[] {
  const pathSegments = entry.searchPath.split("/").filter(Boolean);
  const candidates = new Set<string>();

  candidates.add(entry.searchBasename);
  candidates.add(entry.searchPath);

  for (let index = 1; index < pathSegments.length; index += 1) {
    candidates.add(pathSegments.slice(index).join("/"));
  }

  return [...candidates].sort((left, right) => right.length - left.length);
}

function buildExtensionCandidates(entry: FileEntry): string[] {
  const candidates: string[] = [];
  const basename = entry.searchBasename;

  for (let index = basename.indexOf("."); index >= 0; index = basename.indexOf(".", index + 1)) {
    const candidate = basename.slice(index + 1);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function resolveRelativeUriFromDirectory(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
  if (baseUri.scheme !== "file") {
    return vscode.Uri.joinPath(baseUri, relativePath);
  }

  return vscode.Uri.file(path.resolve(baseUri.fsPath, relativePath));
}

function resolveRelativeUriFromFile(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
  if (baseUri.scheme !== "file") {
    return vscode.Uri.joinPath(vscode.Uri.joinPath(baseUri, ".."), relativePath);
  }

  return vscode.Uri.file(path.resolve(path.dirname(baseUri.fsPath), relativePath));
}

function toInlineIconPath(iconUri: vscode.Uri): vscode.IconPath | undefined {
  const resolvedUri = inlineIconUri(iconUri) ?? iconUri;

  return {
    light: resolvedUri,
    dark: resolvedUri,
  };
}

function inlineIconUri(iconUri: vscode.Uri): vscode.Uri | undefined {
  if (iconUri.scheme !== "file") {
    return iconUri;
  }

  try {
    const content = fs.readFileSync(iconUri.fsPath);
    const mimeType = getMimeType(iconUri.fsPath);

    return vscode.Uri.parse(`data:${mimeType};base64,${content.toString("base64")}`);
  } catch {
    return iconUri;
  }
}

function getMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
