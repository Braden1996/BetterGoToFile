import * as vscode from "vscode";
import { createFileEntry, type FileEntry } from "./file-entry";
import { isPackageManifestPath } from "./package-root";
import { toRelativeWorkspacePath } from "./workspace-path";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

export interface IndexedFileNode {
  readonly name: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
  readonly isPackageManifest: boolean;
  readonly fingerprint: string;
}

export interface IndexedDirectoryNode {
  readonly name: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
  readonly directories: ReadonlyMap<string, IndexedDirectoryNode>;
  readonly files: ReadonlyMap<string, IndexedFileNode>;
  readonly hasPackageManifest: boolean;
  readonly fileCount: number;
  readonly fingerprint: string;
}

export interface WorkspaceFolderIndexSnapshot {
  readonly workspaceFolderPath: string;
  readonly workspaceFolderName: string;
  readonly root: IndexedDirectoryNode;
  readonly isTruncated: boolean;
}

interface CreateIndexedFileNodeOptions {
  readonly name: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
}

interface CreateIndexedDirectoryNodeOptions {
  readonly name: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
  readonly directories: ReadonlyMap<string, IndexedDirectoryNode>;
  readonly files: ReadonlyMap<string, IndexedFileNode>;
}

export function createIndexedFileNode(options: CreateIndexedFileNodeOptions): IndexedFileNode {
  const isPackageManifest = isPackageManifestPath(options.relativePath);

  return {
    name: options.name,
    relativePath: options.relativePath,
    uri: options.uri,
    isPackageManifest,
    fingerprint: hashFragments([
      "file",
      options.relativePath,
      isPackageManifest ? "package-manifest" : "regular-file",
    ]),
  };
}

export function createIndexedDirectoryNode(
  options: CreateIndexedDirectoryNodeOptions,
): IndexedDirectoryNode {
  const sortedDirectories = [...options.directories.entries()].sort(compareNamedEntries);
  const sortedFiles = [...options.files.entries()].sort(compareNamedEntries);
  const fragments = ["directory", options.relativePath];
  let fileCount = 0;
  let hasPackageManifest = false;

  for (const [name, directory] of sortedDirectories) {
    fileCount += directory.fileCount;
    fragments.push(`dir:${name}:${directory.fingerprint}`);
  }

  for (const [name, file] of sortedFiles) {
    fileCount += 1;
    hasPackageManifest ||= file.isPackageManifest;
    fragments.push(`file:${name}:${file.fingerprint}`);
  }

  fragments.push(hasPackageManifest ? "package-root" : "plain-directory");

  return {
    name: options.name,
    relativePath: options.relativePath,
    uri: options.uri,
    directories: options.directories,
    files: options.files,
    hasPackageManifest,
    fileCount,
    fingerprint: hashFragments(fragments),
  };
}

export function createEmptyIndexedRoot(uri: vscode.Uri): IndexedDirectoryNode {
  return createIndexedDirectoryNode({
    name: "",
    relativePath: "",
    uri,
    directories: new Map(),
    files: new Map(),
  });
}

export function createWorkspaceFolderIndexSnapshot(
  folder: vscode.WorkspaceFolder,
  root: IndexedDirectoryNode,
  isTruncated: boolean,
): WorkspaceFolderIndexSnapshot {
  return {
    workspaceFolderPath: folder.uri.fsPath,
    workspaceFolderName: folder.name,
    root,
    isTruncated,
  };
}

export function createIndexedRootFromFilePaths(
  workspaceFolderUri: vscode.Uri,
  relativePaths: readonly string[],
): IndexedDirectoryNode {
  if (!relativePaths.length) {
    return createEmptyIndexedRoot(workspaceFolderUri);
  }

  const root = createMutableDirectoryNode("", "", workspaceFolderUri);

  for (const relativePath of relativePaths) {
    insertFilePath(root, relativePath);
  }

  return finalizeMutableDirectoryNode(root);
}

export function getIndexedDirectory(
  root: IndexedDirectoryNode,
  relativeDirectory: string,
): IndexedDirectoryNode | undefined {
  if (!relativeDirectory) {
    return root;
  }

  let current: IndexedDirectoryNode | undefined = root;

  for (const segment of relativeDirectory.split("/")) {
    current = current?.directories.get(segment);

    if (!current) {
      return undefined;
    }
  }

  return current;
}

export function replaceIndexedDirectory(
  root: IndexedDirectoryNode,
  relativeDirectory: string,
  nextDirectory: IndexedDirectoryNode | undefined,
): IndexedDirectoryNode {
  if (!relativeDirectory) {
    return nextDirectory ?? createEmptyIndexedRoot(root.uri);
  }

  const segments = relativeDirectory.split("/");

  return replaceIndexedDirectorySegments(root, segments, nextDirectory);
}

export function collectIndexedFileEntries(
  snapshots: readonly WorkspaceFolderIndexSnapshot[],
  isMultiRoot: boolean,
): readonly FileEntry[] {
  const entries: FileEntry[] = [];

  for (const snapshot of snapshots) {
    collectDirectoryEntries(snapshot, snapshot.root, undefined, entries, isMultiRoot);
  }

  return entries;
}

interface MutableDirectoryNode {
  readonly name: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
  readonly directories: Map<string, MutableDirectoryNode>;
  readonly files: Map<string, IndexedFileNode>;
}

function collectDirectoryEntries(
  snapshot: WorkspaceFolderIndexSnapshot,
  directory: IndexedDirectoryNode,
  currentPackageRoot: IndexedDirectoryNode | undefined,
  entries: FileEntry[],
  isMultiRoot: boolean,
): void {
  const nextPackageRoot = directory.hasPackageManifest ? directory : currentPackageRoot;
  const packageRoot = nextPackageRoot ? toRelativeWorkspacePath(nextPackageRoot.uri) : undefined;

  for (const file of directory.files.values()) {
    const relativePath = toRelativeWorkspacePath(file.uri);

    if (!relativePath) {
      continue;
    }

    entries.push(
      createFileEntry({
        uri: file.uri,
        relativePath,
        packageRoot,
        workspaceFolderPath: snapshot.workspaceFolderPath,
        workspaceFolderName: isMultiRoot ? snapshot.workspaceFolderName : undefined,
      }),
    );
  }

  for (const child of directory.directories.values()) {
    collectDirectoryEntries(snapshot, child, nextPackageRoot, entries, isMultiRoot);
  }
}

function createMutableDirectoryNode(
  name: string,
  relativePath: string,
  uri: vscode.Uri,
): MutableDirectoryNode {
  return {
    name,
    relativePath,
    uri,
    directories: new Map(),
    files: new Map(),
  };
}

function insertFilePath(root: MutableDirectoryNode, relativePath: string): void {
  const segments = relativePath.split("/").filter(Boolean);

  if (!segments.length) {
    return;
  }

  const fileName = segments.pop();

  if (!fileName) {
    return;
  }

  let current = root;
  let currentRelativePath = "";

  for (const segment of segments) {
    currentRelativePath = joinRelativePath(currentRelativePath, segment);
    let child = current.directories.get(segment);

    if (!child) {
      child = createMutableDirectoryNode(
        segment,
        currentRelativePath,
        vscode.Uri.joinPath(root.uri, ...currentRelativePath.split("/")),
      );
      current.directories.set(segment, child);
    }

    current = child;
  }

  current.files.set(
    fileName,
    createIndexedFileNode({
      name: fileName,
      relativePath,
      uri: vscode.Uri.joinPath(root.uri, ...relativePath.split("/")),
    }),
  );
}

function finalizeMutableDirectoryNode(directory: MutableDirectoryNode): IndexedDirectoryNode {
  return createIndexedDirectoryNode({
    name: directory.name,
    relativePath: directory.relativePath,
    uri: directory.uri,
    directories: new Map(
      [...directory.directories.entries()].map(([name, child]) => [
        name,
        finalizeMutableDirectoryNode(child),
      ]),
    ),
    files: directory.files,
  });
}

function replaceIndexedDirectorySegments(
  directory: IndexedDirectoryNode,
  segments: readonly string[],
  nextDirectory: IndexedDirectoryNode | undefined,
): IndexedDirectoryNode {
  const [head, ...tail] = segments;
  const directories = new Map(directory.directories);

  if (!head) {
    return directory;
  }

  if (!tail.length) {
    if (nextDirectory) {
      directories.set(head, nextDirectory);
    } else {
      directories.delete(head);
    }

    return createIndexedDirectoryNode({
      name: directory.name,
      relativePath: directory.relativePath,
      uri: directory.uri,
      directories,
      files: directory.files,
    });
  }

  const child = directories.get(head);

  if (!child) {
    if (!nextDirectory) {
      return directory;
    }

    directories.set(
      head,
      createIndexedDirectoryChain(directory.relativePath, directory.uri, segments, nextDirectory),
    );

    return createIndexedDirectoryNode({
      name: directory.name,
      relativePath: directory.relativePath,
      uri: directory.uri,
      directories,
      files: directory.files,
    });
  }

  directories.set(head, replaceIndexedDirectorySegments(child, tail, nextDirectory));

  return createIndexedDirectoryNode({
    name: directory.name,
    relativePath: directory.relativePath,
    uri: directory.uri,
    directories,
    files: directory.files,
  });
}

function createIndexedDirectoryChain(
  parentRelativePath: string,
  parentUri: vscode.Uri,
  segments: readonly string[],
  leafDirectory: IndexedDirectoryNode,
): IndexedDirectoryNode {
  const [head, ...tail] = segments;
  const relativePath = joinRelativePath(parentRelativePath, head);
  const uri = vscode.Uri.joinPath(parentUri, head);

  if (!tail.length) {
    return leafDirectory;
  }

  return createIndexedDirectoryNode({
    name: head,
    relativePath,
    uri,
    directories: new Map([
      [tail[0], createIndexedDirectoryChain(relativePath, uri, tail, leafDirectory)],
    ]),
    files: new Map(),
  });
}

function compareNamedEntries(
  left: readonly [string, unknown],
  right: readonly [string, unknown],
): number {
  return left[0].localeCompare(right[0]);
}

function joinRelativePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function hashFragments(fragments: readonly string[]): string {
  let hash = FNV_OFFSET_BASIS;

  for (const fragment of fragments) {
    for (let index = 0; index < fragment.length; index += 1) {
      hash ^= BigInt(fragment.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * FNV_PRIME);
    }

    hash ^= 0xffn;
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }

  return hash.toString(16).padStart(16, "0");
}
