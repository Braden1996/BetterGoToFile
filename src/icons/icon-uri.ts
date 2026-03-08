import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createGitignoredIconDataUri } from "./gitignored-icon";
import type { InlineIconPath } from "./types";

let defaultGitignoredIconPath: InlineIconPath | undefined;

export function createGitignoredFileIconPath(): vscode.IconPath {
  defaultGitignoredIconPath ??= toGitignoredInlineIconPath();
  return defaultGitignoredIconPath;
}

export function resolveRelativeUriFromFile(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
  if (baseUri.scheme !== "file") {
    return vscode.Uri.joinPath(vscode.Uri.joinPath(baseUri, ".."), relativePath);
  }

  return vscode.Uri.file(path.resolve(path.dirname(baseUri.fsPath), relativePath));
}

export function toInlineIconPath(iconUri: vscode.Uri): InlineIconPath | undefined {
  const resolvedUri = inlineIconUri(iconUri) ?? iconUri;

  return {
    light: resolvedUri,
    dark: resolvedUri,
  };
}

export function toGitignoredInlineIconPath(baseIconPath?: InlineIconPath): InlineIconPath {
  return {
    light: toGitignoredIconUri(baseIconPath?.light),
    dark: toGitignoredIconUri(baseIconPath?.dark),
  };
}

function toGitignoredIconUri(baseIconUri?: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse(createGitignoredIconDataUri(baseIconUri?.toString(true)));
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
