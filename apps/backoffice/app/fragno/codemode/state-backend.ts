import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  findTextLineIndex,
  getStaticGlobPrefix,
  getTextLineStarts,
  globToRegExp,
  searchTextContent,
  type StateSearchOptions as UploadStateSearchOptions,
} from "@fragno-dev/upload/text-index";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import {
  createUploadFileCollection,
  listUploadFiles,
} from "@/file-collection/create-upload-file-collection";
import { createUploadFileTree } from "@/file-collection/create-upload-file-tree";
import type {
  FileCollection,
  FileSearchMatch,
  FileTree,
  FileTreeEntry,
} from "@/file-collection/file-collection";
import {
  createBackofficeStaticFileCollection,
  type StaticFileArtifactsLoader,
} from "@/files/content/static";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller, type UploadRouteCaller } from "@/fragno/upload-server";

const UPLOAD_MOUNT_POINT = "/workspace";
const STATIC_MOUNT_POINT = "/static";
const UPLOAD_TREE_MAX_PAGES = 100;
const DIRECTORY_MARKER_SUFFIX = "/.fragno/dir-marker";
const DIRECTORY_MARKER_CONTENT_TYPE = "application/x.fragno-directory-marker";

type StateSearchOptions = UploadStateSearchOptions & { regex?: boolean };
type StateMountSearchOptions = UploadStateSearchOptions & { cursor?: string };
type UploadWritePrecondition = { kind: "absent" } | { kind: "revision"; revision: number };
type StateFileSearchOptions = {
  upload?: StateMountSearchOptions;
  static?: StateMountSearchOptions;
};

type StateTextMatch = {
  line: number;
  column: number;
  match: string;
  lineText: string;
  beforeLines?: string[];
  afterLines?: string[];
};

type StateStat = {
  type: "file" | "directory";
  size: number;
  mtime: Date;
  mode?: number;
};

type StateDirent = {
  name: string;
  type: "file" | "directory";
};

type StateFileSearchResult = {
  path: string;
  matches: StateTextMatch[];
};

type StateMountSearchPage = {
  results: StateFileSearchResult[];
  cursor?: string;
  hasMore: boolean;
};

type StateFileSearchPage = {
  upload: StateMountSearchPage;
  static: StateMountSearchPage;
};

type StateMount = {
  mountPoint: string;
  collection: FileCollection;
};

type UploadStateMount = StateMount & {
  routes: UploadRouteCaller;
  provider: string;
};

type UploadFileEntry = Extract<FileTreeEntry, { kind: "file" }>;

type ResolvedStatePath = {
  kind: "upload" | "static";
  absolutePath: string;
  relativePath: string;
};

type StateBackendMounts = {
  upload: UploadStateMount;
  static: StateMount;
};

export interface BackofficeStateBackend {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<StateStat | null>;
  lstat(path: string): Promise<StateStat | null>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes(path: string): Promise<StateDirent[]>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  cp(src: string, dest: string): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  symlink(target: string, linkPath: string): never;
  readlink(path: string): never;
  realpath(path: string): Promise<string>;
  resolvePath(base: string, path: string): string;
  glob(pattern: string): Promise<string[]>;
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, value: unknown, options?: { spaces?: number }): Promise<void>;
  searchText(path: string, query: string, options?: StateSearchOptions): Promise<StateTextMatch[]>;
  searchFiles(
    pattern: string,
    query: string,
    options?: StateFileSearchOptions,
  ): Promise<StateFileSearchPage>;
  hashFile(path: string, algorithm: "md5" | "sha1" | "sha256"): Promise<string>;
}

export const createBackofficeStateBackend = (input: {
  uploadObject: FetchObject;
  staticFileArtifacts: StaticFileArtifactsLoader;
}): BackofficeStateBackend => {
  const routes = createUploadRouteCaller(input.uploadObject);

  return new UploadStaticStateBackend({
    upload: {
      mountPoint: UPLOAD_MOUNT_POINT,
      routes,
      provider: UPLOAD_PROVIDER_DATABASE,
      collection: createUploadFileCollection({
        routes,
        provider: UPLOAD_PROVIDER_DATABASE,
        maxPages: UPLOAD_TREE_MAX_PAGES,
        getFileResponse: ({ provider: fileProvider, fileKey }) =>
          input.uploadObject.fetch(
            new Request(
              `https://upload.internal/api/upload/files/by-key/content?${new URLSearchParams({
                provider: fileProvider,
                key: fileKey,
              })}`,
            ),
          ),
      }),
    },
    static: {
      mountPoint: STATIC_MOUNT_POINT,
      collection: createBackofficeStaticFileCollection(input.staticFileArtifacts),
    },
  });
};

class UploadStaticStateBackend implements BackofficeStateBackend {
  readonly #upload: UploadStateMount;
  readonly #static: StateMount;
  #uploadTreePromise: Promise<FileTree> | undefined;

  constructor(options: StateBackendMounts) {
    this.#upload = options.upload;
    this.#static = options.static;
  }

  async readFile(path: string): Promise<string> {
    const content = await this.#getFile(path);
    return await new Response(content.body).text();
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const content = await this.#getFile(path);
    return new Uint8Array(await new Response(content.body).arrayBuffer());
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#writeUploadFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.#writeUploadFile(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolveWritableUploadPath(path, "append");
    const appendedBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const existingEntry = await this.#assertWritableFilePath(resolved, "append");
    if (existingEntry) {
      const existingFile = await this.#upload.collection.getFile(resolved.relativePath);
      if (!existingFile || existingEntry.contentVersion === undefined) {
        throw new Error(
          `Unable to append '${resolved.absolutePath}': the file changed while reading.`,
        );
      }

      const currentBytes = new Uint8Array(await new Response(existingFile.body).arrayBuffer());
      const nextBytes = new Uint8Array(currentBytes.byteLength + appendedBytes.byteLength);
      nextBytes.set(currentBytes);
      nextBytes.set(appendedBytes, currentBytes.byteLength);
      await this.#writeResolvedUploadFile(resolved, nextBytes, {
        kind: "revision",
        revision: Number(existingEntry.contentVersion),
      });
      return;
    }

    await this.#writeResolvedUploadFile(resolved, appendedBytes, {
      kind: "absent",
    });
  }

  async exists(path: string): Promise<boolean> {
    if (isStateRoot(path)) {
      return true;
    }
    return (await this.#getEntry(this.#resolvePath(path))) !== null;
  }

  async stat(path: string): Promise<StateStat | null> {
    if (isStateRoot(path)) {
      return { type: "directory", size: 0, mtime: new Date(0), mode: 0o555 };
    }
    const resolved = this.#resolvePath(path);
    const entry = await this.#getEntry(resolved);
    if (!entry) {
      return null;
    }

    return {
      type: entry.kind,
      size: entry.kind === "file" ? (entry.sizeBytes ?? 0) : 0,
      mtime: entry.updatedAt ? new Date(entry.updatedAt) : new Date(0),
      mode:
        entry.kind === "directory"
          ? resolved.kind === "static"
            ? 0o555
            : 0o775
          : resolved.kind === "static"
            ? 0o444
            : 0o664,
    };
  }

  lstat(path: string): Promise<StateStat | null> {
    return this.stat(path);
  }

  async mkdir(path: string): Promise<void> {
    const resolved = this.#resolveWritableUploadPath(path, "mkdir");
    if (!resolved.relativePath) {
      return;
    }

    const tree = await this.#getUploadTree();
    const entriesByPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
    const existing = entriesByPath.get(resolved.relativePath);
    if (existing) {
      throw stateError(existing.kind === "directory" ? "EEXIST" : "ENOTDIR", "mkdir", path);
    }

    const parentPath = posix.dirname(resolved.relativePath);
    const parent = parentPath === "." ? undefined : entriesByPath.get(parentPath);
    if (parentPath !== "." && !parent) {
      throw stateError("ENOENT", "mkdir", path);
    }
    if (parent?.kind === "file") {
      throw stateError("ENOTDIR", "mkdir", path);
    }

    await this.#writeDirectoryMarker(resolved.relativePath);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<StateDirent[]> {
    if (isStateRoot(path)) {
      return [this.#upload.mountPoint, this.#static.mountPoint]
        .map((mountPoint) => ({
          name: posix.basename(mountPoint),
          type: "directory" as const,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    const resolved = this.#resolvePath(path);
    const tree = await this.#getTree(resolved.kind);
    const entry = resolved.relativePath
      ? tree.entries.find((candidate) => candidate.path === resolved.relativePath)
      : { kind: "directory" as const };
    if (!entry) {
      throw stateError("ENOENT", "readdir", resolved.absolutePath);
    }
    if (entry.kind !== "directory") {
      throw stateError("ENOTDIR", "readdir", resolved.absolutePath);
    }

    const parentPrefix = resolved.relativePath ? `${resolved.relativePath}/` : "";
    return tree.entries
      .flatMap<StateDirent>((candidate) => {
        if (!candidate.path.startsWith(parentPrefix)) {
          return [];
        }
        const remainder = candidate.path.slice(parentPrefix.length);
        if (!remainder || remainder.includes("/")) {
          return [];
        }
        return [{ name: remainder, type: candidate.kind }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async rm(path: string, options?: { force?: boolean }): Promise<void> {
    const resolved = this.#resolveWritableUploadPath(path, "rm");
    if (!resolved.relativePath) {
      throw stateError("EPERM", "rm", resolved.absolutePath);
    }

    if (await this.#tryDeleteUploadKey(this.#toUploadKey(resolved.relativePath))) {
      return;
    }

    const tree = await this.#getUploadTree();
    const entry = tree.entries.find((candidate) => candidate.path === resolved.relativePath);
    if (!entry) {
      if (options?.force) {
        return;
      }
      throw stateError("ENOENT", "rm", resolved.absolutePath);
    }

    if (entry.kind === "file") {
      await this.#deleteUploadKey(this.#toUploadKey(entry.path), options?.force === true);
      return;
    }

    const descendantPrefix = `${entry.path}/`;
    const descendants = tree.entries.filter((candidate) =>
      candidate.path.startsWith(descendantPrefix),
    );
    if (descendants.length > 0) {
      throw stateError("ENOTEMPTY", "rm", resolved.absolutePath);
    }

    if (isDirectoryMarkerEntry(entry)) {
      await this.#deleteUploadKey(
        this.#toUploadKey(`${entry.path}${DIRECTORY_MARKER_SUFFIX}`),
        options?.force === true,
      );
    }
  }

  async cp(src: string, dest: string): Promise<void> {
    const source = this.#resolveWritableUploadPath(src, "cp");
    const destination = this.#resolveWritableUploadPath(dest, "cp");
    await this.#assertWritableFilePath(destination, "cp");
    await this.#writeResolvedUploadFile(destination, await this.readFileBytes(source.absolutePath));
  }

  async mv(src: string, dest: string): Promise<void> {
    const source = this.#resolveWritableUploadPath(src, "mv");
    const destination = this.#resolveWritableUploadPath(dest, "mv");
    const sourceEntry = await this.#requireUploadFileEntry(source, "mv");
    if (source.absolutePath === destination.absolutePath) {
      return;
    }

    const [destinationEntry, content] = await Promise.all([
      this.#assertWritableFilePath(destination, "mv"),
      this.readFileBytes(source.absolutePath),
    ]);
    const preparedUploadId = await this.#prepareUploadFile(
      destination,
      content,
      sourceEntry.contentType ?? inferContentType(destination.relativePath),
    );
    const sourceRevision = requireContentRevision(sourceEntry, source.absolutePath, "mv");
    const destinationPrecondition: UploadWritePrecondition = destinationEntry
      ? {
          kind: "revision",
          revision: requireContentRevision(destinationEntry, destination.absolutePath, "mv"),
        }
      : { kind: "absent" };
    const response = await this.#upload.routes("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: preparedUploadId,
            precondition: destinationPrecondition,
          },
          {
            kind: "delete",
            provider: this.#upload.provider,
            fileKey: this.#toUploadKey(source.relativePath),
            precondition: { kind: "revision", revision: sourceRevision },
          },
        ],
      },
    });
    requireUploadMutation(
      response,
      `move '${source.absolutePath}' to '${destination.absolutePath}'`,
    );
    this.#invalidateUploadTree();
  }

  symlink(_target: string, linkPath: string): never {
    throw stateError("ENOTSUP", "symlink", linkPath);
  }

  readlink(path: string): never {
    throw stateError("ENOTSUP", "readlink", path);
  }

  async realpath(path: string): Promise<string> {
    if (isStateRoot(path)) {
      return "/";
    }
    const resolved = this.#resolvePath(path);
    if (!(await this.#getEntry(resolved))) {
      throw stateError("ENOENT", "realpath", resolved.absolutePath);
    }
    return resolved.absolutePath;
  }

  resolvePath(base: string, path: string): string {
    const normalizedBase = base.startsWith("/") ? base : posix.join(this.#upload.mountPoint, base);
    return posix.resolve(normalizedBase, path);
  }

  async glob(pattern: string): Promise<string[]> {
    const absolutePattern =
      pattern.startsWith("/") || pattern.startsWith("**/")
        ? pattern
        : posix.join(this.#upload.mountPoint, pattern);
    const expression = globToRegExp(absolutePattern);
    const uploadPattern = stripMountFromPattern(absolutePattern, this.#upload.mountPoint);
    const uploadPrefix = getStaticGlobPrefix(uploadPattern);
    const uploadTreePromise = patternCanMatchMount(absolutePattern, this.#upload.mountPoint)
      ? uploadPrefix
        ? listUploadFiles({
            routes: this.#upload.routes,
            provider: this.#upload.provider,
            glob: uploadPattern,
            maxPages: UPLOAD_TREE_MAX_PAGES,
          }).then((files) => createUploadFileTree(files, { provider: this.#upload.provider }))
        : this.#getUploadTree()
      : null;
    const [uploadTree, staticTree] = await Promise.all([
      uploadTreePromise,
      patternCanMatchMount(absolutePattern, this.#static.mountPoint)
        ? this.#static.collection.getTree()
        : null,
    ]);

    return [
      this.#upload.mountPoint,
      this.#static.mountPoint,
      ...(uploadTree?.entries.map((entry) => this.#toUploadAbsolutePath(entry.path)) ?? []),
      ...(staticTree?.entries.map((entry) => joinMountPath(this.#static.mountPoint, entry.path)) ??
        []),
    ]
      .filter((path) => expression.test(path.replace(/^\/+/, "")))
      .sort();
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await this.readFile(path)) as unknown;
  }

  async writeJson(path: string, value: unknown, options?: { spaces?: number }): Promise<void> {
    const content = JSON.stringify(value, null, options?.spaces ?? 2);
    if (content === undefined) {
      throw new TypeError("State JSON value is not serializable.");
    }
    await this.writeFile(path, content);
  }

  async searchText(
    path: string,
    query: string,
    options: StateSearchOptions = {},
  ): Promise<StateTextMatch[]> {
    return toStateTextMatches(await this.readFile(path), query, options);
  }

  async searchFiles(
    pattern: string,
    query: string,
    options?: StateFileSearchOptions,
  ): Promise<StateFileSearchPage> {
    const searchMount = async (
      mount: StateMount,
      mountOptions: StateMountSearchOptions | undefined,
      shouldSearch: boolean,
    ): Promise<StateMountSearchPage> => {
      if (!shouldSearch || !patternCanMatchMount(pattern, mount.mountPoint)) {
        return { results: [], hasMore: false };
      }

      const { cursor, ...searchOptions } = mountOptions ?? {};
      const page = await mount.collection.searchFiles(
        stripMountFromPattern(pattern, mount.mountPoint),
        query,
        searchOptions,
        cursor,
      );

      return {
        results: groupStateFileSearchMatches(mount.mountPoint, page.matches),
        ...(page.cursor ? { cursor: page.cursor } : {}),
        hasMore: page.hasMore,
      };
    };

    const hasMountSelection = options?.upload !== undefined || options?.static !== undefined;
    const [upload, staticFiles] = await Promise.all([
      searchMount(
        this.#upload,
        options?.upload,
        !hasMountSelection || options?.upload !== undefined,
      ),
      searchMount(
        this.#static,
        options?.static,
        !hasMountSelection || options?.static !== undefined,
      ),
    ]);

    return { upload, static: staticFiles };
  }

  async hashFile(path: string, algorithm: "md5" | "sha1" | "sha256"): Promise<string> {
    return createHash(algorithm)
      .update(await this.readFileBytes(path))
      .digest("hex");
  }

  async #getFile(path: string) {
    const resolved = this.#resolvePath(path);
    // Collection roots are implicit directories and cannot be requested as files with an empty path.
    if (!resolved.relativePath) {
      throw stateError("EISDIR", "read", resolved.absolutePath);
    }

    const content = await this.#collectionFor(resolved.kind).getFile(resolved.relativePath);
    if (content) {
      return content;
    }

    const entry = await this.#getEntry(resolved);
    if (entry?.kind === "directory") {
      throw stateError("EISDIR", "read", resolved.absolutePath);
    }
    throw stateError("ENOENT", "read", resolved.absolutePath);
  }

  async #writeUploadFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolveWritableUploadPath(path, "write");
    // FIXME: Reject writes to virtual directories before creating an Upload file.
    await this.#writeResolvedUploadFile(resolved, content);
  }

  async #assertWritableFilePath(
    resolved: ResolvedStatePath,
    operation: string,
  ): Promise<UploadFileEntry | null> {
    if (!resolved.relativePath) {
      throw stateError("EISDIR", operation, resolved.absolutePath);
    }

    const existingFile = await this.#getUploadFileEntry(resolved.relativePath);
    if (existingFile) {
      return existingFile;
    }

    const tree = await this.#getUploadTree();
    const target = tree.entries.find((entry) => entry.path === resolved.relativePath);
    if (target?.kind === "directory") {
      throw stateError("EISDIR", operation, resolved.absolutePath);
    }

    const parentFile = tree.entries.find(
      (entry) => entry.kind === "file" && resolved.relativePath.startsWith(`${entry.path}/`),
    );
    if (parentFile) {
      throw stateError("ENOTDIR", operation, resolved.absolutePath);
    }

    return null;
  }

  async #requireUploadFileEntry(
    resolved: ResolvedStatePath,
    operation: string,
  ): Promise<UploadFileEntry> {
    if (!resolved.relativePath) {
      throw stateError("EISDIR", operation, resolved.absolutePath);
    }

    const entry = await this.#getUploadFileEntry(resolved.relativePath);
    if (entry) {
      return entry;
    }

    const resolvedEntry = await this.#getEntry(resolved);
    if (resolvedEntry?.kind === "directory") {
      throw stateError("EISDIR", operation, resolved.absolutePath);
    }
    throw stateError("ENOENT", operation, resolved.absolutePath);
  }

  async #prepareUploadFile(
    destination: ResolvedStatePath,
    content: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const created = await this.#upload.routes("POST", "/uploads", {
      body: {
        provider: this.#upload.provider,
        fileKey: this.#toUploadKey(destination.relativePath),
        filename: posix.basename(destination.relativePath),
        sizeBytes: content.byteLength,
        contentType,
        publicationMode: "batch",
      },
    });
    if (created.type === "error") {
      throw new Error(
        `Unable to prepare '${destination.absolutePath}': ${created.error.message} (${created.error.code}, HTTP ${created.status}).`,
      );
    }
    if (created.type !== "json") {
      throw new Error(
        `Unable to prepare '${destination.absolutePath}': Upload returned ${created.type}.`,
      );
    }
    if (created.data.strategy !== "proxy") {
      throw new Error(
        `Unable to prepare '${destination.absolutePath}': Upload returned unsupported ${created.data.strategy} transfer strategy.`,
      );
    }

    const prepared = await this.#upload.routes("PUT", "/uploads/:uploadId/content", {
      pathParams: { uploadId: created.data.uploadId },
      body: new Blob([Uint8Array.from(content)]).stream(),
    });
    if (prepared.type === "error") {
      throw new Error(
        `Unable to prepare '${destination.absolutePath}': ${prepared.error.message} (${prepared.error.code}, HTTP ${prepared.status}).`,
      );
    }
    if (prepared.type !== "json" || prepared.data.kind !== "prepared") {
      throw new Error(`Unable to prepare '${destination.absolutePath}' as an atomic file write.`);
    }
    return prepared.data.write.uploadId;
  }

  async #writeResolvedUploadFile(
    resolved: ResolvedStatePath,
    content: string | Uint8Array,
    precondition?: UploadWritePrecondition,
  ): Promise<void> {
    if (!resolved.relativePath) {
      throw stateError("EISDIR", "write", resolved.absolutePath);
    }

    const form = new FormData();
    const contentType = inferContentType(resolved.relativePath);
    const body = typeof content === "string" ? content : Uint8Array.from(content);
    form.set("provider", this.#upload.provider);
    form.set("fileKey", this.#toUploadKey(resolved.relativePath));
    form.set("filename", posix.basename(resolved.relativePath));
    form.set("file", new Blob([body], { type: contentType }));
    if (precondition) {
      form.set("precondition", JSON.stringify(precondition));
    }
    requireUploadMutation(
      await this.#upload.routes("POST", "/files", { body: form }),
      `write '${resolved.absolutePath}'`,
    );
    this.#invalidateUploadTree();
  }

  async #writeDirectoryMarker(relativePath: string): Promise<void> {
    const form = new FormData();
    form.set("provider", this.#upload.provider);
    form.set("fileKey", this.#toUploadKey(`${relativePath}${DIRECTORY_MARKER_SUFFIX}`));
    form.set("filename", "dir-marker");
    form.set("metadata", JSON.stringify({ __docsDirectoryMarker: true }));
    form.set("file", new Blob([""], { type: DIRECTORY_MARKER_CONTENT_TYPE }));
    requireUploadMutation(
      await this.#upload.routes("POST", "/files", { body: form }),
      `create directory '${this.#toUploadAbsolutePath(relativePath)}'`,
    );
    this.#invalidateUploadTree();
  }

  async #tryDeleteUploadKey(key: string): Promise<boolean> {
    const response = await this.#upload.routes("DELETE", "/files/by-key", {
      query: { provider: this.#upload.provider, key },
    });
    this.#invalidateUploadTree();
    if (response.type === "error" && response.error.code === "FILE_NOT_FOUND") {
      return false;
    }
    requireUploadMutation(response, `delete '${key}'`);
    return true;
  }

  async #deleteUploadKey(key: string, force: boolean): Promise<void> {
    const response = await this.#upload.routes("DELETE", "/files/by-key", {
      query: { provider: this.#upload.provider, key },
    });
    if (!(force && response.type === "error" && response.error.code === "FILE_NOT_FOUND")) {
      requireUploadMutation(response, `delete '${key}'`);
    }
    this.#invalidateUploadTree();
  }

  async #getEntry(resolved: ResolvedStatePath): Promise<FileTreeEntry | null> {
    if (!resolved.relativePath) {
      return {
        kind: "directory",
        path: "",
        updatedAt: null,
        metadata: null,
      };
    }
    if (resolved.kind === "upload") {
      const file = await this.#getUploadFileEntry(resolved.relativePath);
      if (file) {
        return file;
      }
    }
    const tree = await this.#getTree(resolved.kind);
    return tree.entries.find((entry) => entry.path === resolved.relativePath) ?? null;
  }

  async #getUploadFileEntry(relativePath: string): Promise<UploadFileEntry | null> {
    const response = await this.#upload.routes("GET", "/files/by-key", {
      query: {
        provider: this.#upload.provider,
        key: this.#toUploadKey(relativePath),
      },
    });
    if (response.type === "error") {
      if (response.error.code === "FILE_NOT_FOUND") {
        return null;
      }
      throw new Error(
        `Unable to inspect '${this.#toUploadAbsolutePath(relativePath)}': ${response.error.message} (${response.error.code}, HTTP ${response.status}).`,
      );
    }
    if (response.type !== "json") {
      throw new Error(
        `Unable to inspect '${this.#toUploadAbsolutePath(relativePath)}': Upload returned ${response.type}.`,
      );
    }
    if (response.data.status === "deleted") {
      return null;
    }
    return {
      kind: "file",
      path: relativePath,
      displayName: response.data.filename,
      sizeBytes: response.data.sizeBytes,
      contentType: response.data.contentType,
      updatedAt: response.data.updatedAt,
      metadata: response.data.metadata,
      contentVersion: String(response.data.revision),
    };
  }

  #getTree(kind: ResolvedStatePath["kind"]): Promise<FileTree> {
    return kind === "upload" ? this.#getUploadTree() : this.#static.collection.getTree();
  }

  #getUploadTree(): Promise<FileTree> {
    return (this.#uploadTreePromise ??= this.#upload.collection.getTree());
  }

  #invalidateUploadTree(): void {
    this.#uploadTreePromise = undefined;
  }

  #collectionFor(kind: ResolvedStatePath["kind"]): FileCollection {
    return kind === "upload" ? this.#upload.collection : this.#static.collection;
  }

  #resolveWritableUploadPath(path: string, operation: string): ResolvedStatePath {
    const resolved = this.#resolvePath(path);
    if (resolved.kind === "static") {
      throw stateError("EROFS", operation, resolved.absolutePath);
    }
    return resolved;
  }

  #resolvePath(path: string): ResolvedStatePath {
    const absolutePath = path.startsWith("/")
      ? posix.resolve("/", path)
      : posix.resolve(this.#upload.mountPoint, path);

    const uploadRelativePath = relativePathWithinMount(absolutePath, this.#upload.mountPoint);
    if (uploadRelativePath !== null) {
      return { kind: "upload", absolutePath, relativePath: uploadRelativePath };
    }

    const staticRelativePath = relativePathWithinMount(absolutePath, this.#static.mountPoint);
    if (staticRelativePath !== null) {
      return { kind: "static", absolutePath, relativePath: staticRelativePath };
    }

    throw new Error(
      `State path '${path}' is outside '${this.#upload.mountPoint}' and '${this.#static.mountPoint}'.`,
    );
  }

  #toUploadKey(relativePath: string): string {
    return relativePath;
  }

  #toUploadAbsolutePath(relativePath: string): string {
    return joinMountPath(this.#upload.mountPoint, relativePath);
  }
}

const isStateRoot = (path: string): boolean =>
  path.startsWith("/") && posix.resolve("/", path) === "/";

const relativePathWithinMount = (path: string, mountPoint: string): string | null => {
  if (path === mountPoint) {
    return "";
  }
  return path.startsWith(`${mountPoint}/`) ? path.slice(mountPoint.length + 1) : null;
};

const joinMountPath = (mountPoint: string, relativePath: string): string =>
  relativePath ? `${mountPoint}/${relativePath}` : mountPoint;

const isDirectoryMarkerEntry = (entry: FileTreeEntry): boolean =>
  entry.kind === "directory" && entry.metadata?.__docsDirectoryMarker === true;

const stateError = (code: string, operation: string, path: string): Error =>
  new Error(`${code}: ${operation} '${path}'`);

const requireContentRevision = (
  entry: UploadFileEntry,
  path: string,
  operation: string,
): number => {
  if (entry.contentVersion === undefined) {
    throw new Error(`Unable to ${operation} '${path}': Upload omitted the file revision.`);
  }
  return Number(entry.contentVersion);
};

const requireUploadMutation = (
  response:
    | { type: "json" }
    | {
        type: "error";
        error: { message: string; code: string };
        status: number;
      }
    | { type: string },
  operation: string,
): void => {
  if (response.type === "error" && "error" in response) {
    throw new Error(
      `Unable to ${operation}: ${response.error.message} (${response.error.code}, HTTP ${response.status}).`,
    );
  }
  if (response.type !== "json") {
    throw new Error(`Unable to ${operation}: Upload returned ${response.type}.`);
  }
};

const patternCanMatchMount = (pattern: string, mountPoint: string): boolean =>
  !pattern.startsWith("/") || pattern === mountPoint || pattern.startsWith(`${mountPoint}/`);

const stripMountFromPattern = (pattern: string, mountPoint: string): string => {
  if (!pattern.startsWith("/")) {
    return pattern;
  }
  if (pattern === mountPoint) {
    return "";
  }
  return pattern.slice(mountPoint.length + 1);
};

const groupStateFileSearchMatches = (
  mountPoint: string,
  matches: readonly FileSearchMatch[],
): StateFileSearchResult[] => {
  const matchesByPath = new Map<string, StateTextMatch[]>();

  for (const match of matches) {
    const path = joinMountPath(mountPoint, match.path);
    matchesByPath.set(path, [
      ...(matchesByPath.get(path) ?? []),
      {
        line: match.line,
        column: match.column,
        match: match.text,
        lineText: match.lineText,
        ...(match.contextBefore.length > 0 ? { beforeLines: [...match.contextBefore] } : {}),
        ...(match.contextAfter.length > 0 ? { afterLines: [...match.contextAfter] } : {}),
      },
    ]);
  }

  return [...matchesByPath].map(([path, pathMatches]) => ({
    path,
    matches: pathMatches,
  }));
};

const toStateTextMatches = (
  content: string,
  query: string,
  options: StateSearchOptions,
): StateTextMatch[] => {
  return searchStateContent("", content, query, options).map((match) => ({
    line: match.line,
    column: match.column,
    match: match.text,
    lineText: match.lineText,
    ...(match.contextBefore.length > 0 ? { beforeLines: [...match.contextBefore] } : {}),
    ...(match.contextAfter.length > 0 ? { afterLines: [...match.contextAfter] } : {}),
  }));
};

const searchStateContent = (
  path: string,
  content: string,
  query: string,
  options: StateSearchOptions,
): FileSearchMatch[] => {
  if (!options.regex) {
    const lines = content.split(/\r?\n/);
    return searchTextContent(path, content, query, options).map((match) => ({
      ...match,
      lineText: lines[match.line - 1] ?? "",
    }));
  }

  const maxMatches = Math.max(0, options.maxMatches ?? 50);
  if (!query || maxMatches === 0) {
    return [];
  }

  const source = options.wholeWord ? `\\b(?:${query})\\b` : query;
  const expression = new RegExp(source, `g${options.caseSensitive ? "" : "i"}`);
  const lines = content.split(/\r?\n/);
  const lineStarts = getTextLineStarts(content);

  const matches: FileSearchMatch[] = [];
  for (const match of content.matchAll(expression)) {
    if (matches.length >= maxMatches) {
      break;
    }
    const startOffset = match.index;
    const lineIndex = findTextLineIndex(lineStarts, startOffset);
    const contextBefore = Math.max(0, options.contextBefore ?? 0);
    const contextAfter = Math.max(0, options.contextAfter ?? 0);
    matches.push({
      path,
      line: lineIndex + 1,
      column: startOffset - (lineStarts[lineIndex] ?? 0) + 1,
      text: match[0],
      lineText: lines[lineIndex] ?? "",
      contextBefore: lines.slice(Math.max(0, lineIndex - contextBefore), lineIndex),
      contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + contextAfter),
    });
  }
  return matches;
};

const inferContentType = (path: string): string => {
  const extension = posix.extname(path).toLowerCase();
  switch (extension) {
    case ".md":
    case ".mdx":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".txt":
    case ".log":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
};
