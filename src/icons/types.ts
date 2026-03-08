import * as vscode from "vscode";
import type { FileEntry } from "../workspace";

export interface IconThemeContribution {
  readonly id: string;
  readonly path: string;
}

export interface IconThemeData {
  readonly iconDefinitions?: Record<string, IconDefinition>;
  readonly file?: string;
  readonly fileExtensions?: Record<string, string>;
  readonly fileNames?: Record<string, string>;
  readonly light?: IconThemeOverrideData;
  readonly highContrast?: IconThemeOverrideData;
}

export interface IconThemeOverrideData {
  readonly file?: string;
  readonly fileExtensions?: Record<string, string>;
  readonly fileNames?: Record<string, string>;
}

export interface IconDefinition {
  readonly iconPath?: string;
}

export interface IconThemeOverride {
  readonly file?: string;
  readonly fileExtensions: ReadonlyMap<string, string>;
  readonly fileNames: ReadonlyMap<string, string>;
}

export interface InlineIconPath {
  readonly light: vscode.Uri;
  readonly dark: vscode.Uri;
}

export interface FileIconResolver {
  resolve(entry: FileEntry): vscode.IconPath | undefined;
  resolveGitignored(entry: FileEntry): vscode.IconPath;
  describe(entry: FileEntry): string;
}
