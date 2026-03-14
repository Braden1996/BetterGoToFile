import * as vscode from "vscode";
import { isRecord, normalizeOptionalString } from "./icon-theme-parser";
import {
  createLanguageAssociationResolver,
  type FileAssociationData,
  type LanguageAssociationResolver,
  type LanguageContributionData,
} from "./language-association-resolver";

export function loadLanguageAssociationResolver(
  log?: (message: string) => void,
): LanguageAssociationResolver {
  const contributions = vscode.extensions.all.flatMap((extension) =>
    getLanguageContributions(extension.packageJSON),
  );
  const configuredAssociations = getConfiguredFileAssociations();

  log?.(
    `Loaded ${contributions.length} contributed language associations and ${configuredAssociations.length} configured file associations.`,
  );

  return createLanguageAssociationResolver({
    contributions,
    configuredAssociations,
  });
}

function getLanguageContributions(packageJson: unknown): readonly LanguageContributionData[] {
  if (!isRecord(packageJson)) {
    return [];
  }

  const contributes = packageJson["contributes"];

  if (!isRecord(contributes)) {
    return [];
  }

  const languages = contributes["languages"];

  if (!Array.isArray(languages)) {
    return [];
  }

  return languages.flatMap((language): LanguageContributionData[] => {
    if (!isRecord(language)) {
      return [];
    }

    const id = normalizeOptionalString(language["id"]);

    if (!id) {
      return [];
    }

    return [
      {
        id,
        extensions: readStringArray(language["extensions"]),
        filenames: readStringArray(language["filenames"]),
        filenamePatterns: readStringArray(language["filenamePatterns"]),
      },
    ];
  });
}

function getConfiguredFileAssociations(): readonly FileAssociationData[] {
  const configuredAssociations =
    vscode.workspace.getConfiguration("files").get<Record<string, string>>("associations") ?? {};

  return Object.entries(configuredAssociations).flatMap(([pattern, languageId]) => {
    if (typeof languageId !== "string" || !languageId) {
      return [];
    }

    return [
      {
        pattern,
        languageId,
      },
    ];
  });
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
