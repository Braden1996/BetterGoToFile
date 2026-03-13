import * as vscode from "vscode";
import { createGitignoredFileIconPath, loadFileIconResolver } from "../../icons";
import { type FilePickItem, SearchRuntime, searchFileItems } from "../../search";
import type { FileEntry } from "../../workspace";
import {
  formatFilePickerTitle,
  getPendingFilePickerItem,
  shouldLockFilePickerEntries,
} from "./file-picker-presentation";

interface ShowBetterGoToFileOptions {
  readonly debugScoring?: boolean;
}

const SEARCH_DEBOUNCE_MS = 40;

export async function showBetterGoToFile(
  outputChannel: vscode.OutputChannel,
  runtime: SearchRuntime,
  options: ShowBetterGoToFileOptions = {},
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage("Open a workspace folder to use Better Go To File.");
    return;
  }

  const quickPick = vscode.window.createQuickPick<FilePickItem>();
  const disposables: vscode.Disposable[] = [];
  const quickPickWithSort = quickPick as vscode.QuickPick<FilePickItem> & {
    sortByLabel?: boolean;
  };
  const log = (message: string): void => {
    outputChannel.appendLine(`[icons] ${message}`);
  };
  const fallbackGitignoredIconPath = createGitignoredFileIconPath();
  let resolveFileIcon: ((entry: FileEntry) => vscode.IconPath | undefined) | undefined;
  let resolveGitignoredIcon: (entry: FileEntry) => vscode.IconPath = () =>
    fallbackGitignoredIconPath;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchGeneration = 0;
  let isDisposed = false;
  let sessionEntries = runtime.getEntries();
  let hasLockedSessionEntries = shouldLockEntries();

  quickPick.title = formatFilePickerTitle(true);
  quickPick.placeholder =
    "Search files, content, and symbols (append : to go to line or @ to go to symbol)";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = false;
  quickPick.ignoreFocusOut = false;
  quickPickWithSort.sortByLabel = false;
  quickPick.busy = true;
  quickPick.show();

  const setSearching = (isSearching: boolean): void => {
    if (isDisposed) {
      return;
    }

    quickPick.busy = isSearching;
    quickPick.title = formatFilePickerTitle(isSearching);
  };

  const showError = (error: unknown): void => {
    if (isDisposed) {
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown error";

    quickPick.items = [
      {
        label: "Unable to load files",
        description: message,
        alwaysShow: true,
      },
    ];
    setSearching(false);
  };

  const getPendingItems = (query: string): FilePickItem[] | undefined => {
    if (!sessionEntries.length && !runtime.isReadyForPicker()) {
      return [
        {
          label: query.trim() ? "Searching workspace files..." : "Loading workspace files...",
          description: "Preparing tracked file metadata.",
          alwaysShow: true,
        },
      ];
    }

    const status = runtime.getStatus();
    const pendingItem = getPendingFilePickerItem({
      currentSource: status.index.currentSource,
      hasEntries: sessionEntries.length > 0,
      isIndexing: status.index.isIndexing,
      isRestoringSnapshot: status.index.isRestoringSnapshot,
      query,
    });

    if (!pendingItem) {
      return undefined;
    }

    return [pendingItem];
  };

  const syncSessionEntries = (): void => {
    if (hasLockedSessionEntries) {
      return;
    }

    sessionEntries = runtime.getEntries();
    hasLockedSessionEntries = shouldLockEntries();
  };

  const refreshItems = (query: string, delayMs = SEARCH_DEBOUNCE_MS): void => {
    syncSessionEntries();
    const pendingItems = getPendingItems(query);

    if (pendingItems) {
      quickPick.items = pendingItems;

      if (!hasLockedSessionEntries) {
        setSearching(true);
      }

      return;
    }

    scheduleSearch(query, delayMs);
  };

  const renderItems = (query: string): void => {
    const pendingItems = getPendingItems(query);

    if (pendingItems) {
      quickPick.items = pendingItems;
      return;
    }

    const config = runtime.getConfig();
    const searchResult = searchFileItems(
      sessionEntries,
      query,
      runtime.buildRankingContext(),
      resolveFileIcon,
      resolveGitignoredIcon,
      config,
      options,
    );

    quickPick.items = searchResult.items.slice();
  };

  const scheduleSearch = (query: string, delayMs = SEARCH_DEBOUNCE_MS): void => {
    if (isDisposed) {
      return;
    }

    searchGeneration += 1;
    const currentGeneration = searchGeneration;

    if (searchTimer) {
      clearTimeout(searchTimer);
    }

    setSearching(true);

    const pendingItems = getPendingItems(query);

    if (pendingItems) {
      quickPick.items = pendingItems;
    }

    searchTimer = setTimeout(() => {
      searchTimer = undefined;

      if (isDisposed || currentGeneration !== searchGeneration) {
        return;
      }

      try {
        renderItems(query);
      } catch (error) {
        showError(error);
        return;
      }

      setSearching(false);
    }, delayMs);
  };

  disposables.push(
    quickPick.onDidChangeValue((value) => {
      scheduleSearch(value);
    }),
    runtime.onDidChange(() => {
      refreshItems(quickPick.value, 0);
    }),
    quickPick.onDidAccept(async () => {
      const selectedItem = quickPick.selectedItems[0];

      if (!selectedItem?.entry) {
        return;
      }

      runtime.recordExplicitOpen(selectedItem.entry.relativePath);
      quickPick.hide();
      await vscode.window.showTextDocument(selectedItem.entry.uri, { preview: false });
    }),
  );

  if (hasLockedSessionEntries) {
    scheduleSearch(quickPick.value, 0);
  } else {
    refreshItems(quickPick.value, 0);
  }

  void runtime.ready().then(
    () => {
      if (isDisposed) {
        return;
      }

      refreshItems(quickPick.value, 0);
    },
    (error) => {
      showError(error);
    },
  );

  void loadFileIconResolver(log).then((fileIconResolver) => {
    if (isDisposed) {
      return;
    }

    if (!fileIconResolver) {
      log("Using generic fallback icons in the picker.");
      return;
    }

    resolveFileIcon = fileIconResolver.resolve.bind(fileIconResolver);
    resolveGitignoredIcon = fileIconResolver.resolveGitignored.bind(fileIconResolver);
    scheduleSearch(quickPick.value, 0);
  });

  quickPick.onDidHide(() => {
    isDisposed = true;

    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }

    for (const disposable of disposables) {
      disposable.dispose();
    }

    quickPick.dispose();
  });

  function shouldLockEntries(): boolean {
    const status = runtime.getStatus();

    return shouldLockFilePickerEntries({
      currentSource: status.index.currentSource,
      hasEntries: sessionEntries.length > 0,
      isIndexing: status.index.isIndexing,
      isRestoringSnapshot: status.index.isRestoringSnapshot,
    });
  }
}
