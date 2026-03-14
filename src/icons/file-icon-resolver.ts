import * as vscode from "vscode";
import type { FileEntry } from "../workspace";
import { findIconThemeContribution, resolveIconThemeUri } from "./icon-theme-discovery";
import {
  isDefined,
  normalizeOptionalString,
  parseIconTheme,
  readAssociationMap,
  readIconDefinitionPaths,
  readThemeOverride,
} from "./icon-theme-parser";
import { resolveThemeIconMatch } from "./icon-matcher";
import { type LanguageAssociationResolver } from "./language-association-resolver";
import { loadLanguageAssociationResolver } from "./language-association-discovery";
import {
  createGitignoredFileIconPath,
  resolveRelativeUriFromFile,
  toGitignoredInlineIconPath,
  toInlineIconPath,
} from "./icon-uri";
import type { FileIconResolver, IconThemeData, IconThemeOverride, InlineIconPath } from "./types";

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
      loadLanguageAssociationResolver(log),
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
  private readonly languageIds: ReadonlyMap<string, string>;
  private readonly lightOverride?: IconThemeOverride;
  private readonly highContrastOverride?: IconThemeOverride;
  private readonly iconPathCache = new Map<string, InlineIconPath | null>();
  private readonly gitignoredIconPathCache = new Map<string, InlineIconPath>();

  constructor(
    private readonly themeUri: vscode.Uri,
    themeData: IconThemeData,
    private readonly colorThemeKind: vscode.ColorThemeKind,
    private readonly languageAssociationResolver: LanguageAssociationResolver,
  ) {
    this.defaultFileIconId = normalizeOptionalString(themeData.file);
    this.iconDefinitionPaths = readIconDefinitionPaths(themeData.iconDefinitions);
    this.fileExtensions = readAssociationMap(themeData.fileExtensions);
    this.fileNames = readAssociationMap(themeData.fileNames);
    this.languageIds = readAssociationMap(themeData.languageIds);
    this.lightOverride = readThemeOverride(themeData.light);
    this.highContrastOverride = readThemeOverride(themeData.highContrast);
  }

  resolve(entry: FileEntry): vscode.IconPath | undefined {
    const match = this.resolveIconMatch(entry);

    if (!match) {
      return undefined;
    }

    return this.getIconPath(match.iconId);
  }

  resolveGitignored(entry: FileEntry): vscode.IconPath {
    const match = this.resolveIconMatch(entry);

    if (!match) {
      return createGitignoredFileIconPath();
    }

    return this.getGitignoredIconPath(match.iconId);
  }

  describe(entry: FileEntry): string {
    const match = this.resolveIconMatch(entry);

    if (!match) {
      return `${entry.relativePath}: no icon match, falling back`;
    }

    const iconDefinitionPath = this.iconDefinitionPaths.get(match.iconId);
    const iconPath = this.getIconPath(match.iconId);

    return [
      `path=${entry.relativePath}`,
      `iconId=${match.iconId}`,
      `source=${match.source}`,
      ...(match.languageId ? [`languageId=${match.languageId}`] : []),
      `definition=${iconDefinitionPath ?? "<missing>"}`,
      `customIcon=${iconPath ? "yes" : "no"}`,
    ].join(", ");
  }

  private resolveIconMatch(entry: FileEntry) {
    return resolveThemeIconMatch(entry, {
      defaultFileIconId: this.defaultFileIconId,
      fileExtensions: this.fileExtensions,
      fileNames: this.fileNames,
      languageIds: this.languageIds,
      overrides: this.getActiveOverrides(),
      resolveLanguageId: this.languageAssociationResolver.resolve.bind(
        this.languageAssociationResolver,
      ),
    });
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

  private getIconPath(iconId: string): InlineIconPath | undefined {
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

  private getGitignoredIconPath(iconId: string): InlineIconPath {
    const cachedIconPath = this.gitignoredIconPathCache.get(iconId);

    if (cachedIconPath) {
      return cachedIconPath;
    }

    const iconPath = toGitignoredInlineIconPath(this.getIconPath(iconId));
    this.gitignoredIconPathCache.set(iconId, iconPath);

    return iconPath;
  }
}
