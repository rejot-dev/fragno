<!-- Extracted from Pi session: /Users/wilco/.pi/agent/sessions/--Users-wilco-dev-fragno.worktrees-wilco-backoffice-filesystems--/2026-06-06T11-50-44-896Z_019e9cc5-6da0-719c-bcdd-7083432fc1b8.jsonl -->

# Backoffice filesystem broad cleanup plan

I’d clean it up by separating **three concerns that are currently blended**:

1. **filesystem mechanics** — read/write/list/stat/path/errors
2. **mount/contributor composition** — “what roots exist for this org?”
3. **Backoffice presentation** — tree nodes, details, explorer actions, previews

Right now those are mixed across `MasterFileSystem`, contributors, `service.ts`, Upload-specific
helpers, and route data.

## Biggest cleanup opportunities

### 1. Rename and narrow the abstractions

`IFileSystem` is huge and POSIX-ish, but most mounts don’t actually support everything.

I’d split it into smaller interfaces:

```ts
interface ReadableFileSystem {
  readFile(path): Promise<string>;
  readFileBuffer(path): Promise<Uint8Array>;
  exists(path): Promise<boolean>;
  stat(path): Promise<FsStat>;
  readdir(path): Promise<string[]>;
}

interface WritableFileSystem {
  writeFile(path, content): Promise<void>;
  mkdir(path, options?): Promise<void>;
  rm(path, options?): Promise<void>;
}

interface StreamingFileSystem {
  readFileStream(path): Promise<ReadableStream<Uint8Array>>;
}

interface MetadataFileSystem {
  chmod(path, mode): Promise<void>;
  utimes(path, atime, mtime): Promise<void>;
}
```

Then `MountedFileSystem` can be composed from capabilities instead of pretending every mount has
every operation.

This would reduce a lot of “method exists but throws unsupported” logic.

---

### 2. Centralize path normalization

There are many local helpers:

- `normalizeAbsolutePath`
- `normalizePath`
- `normalizeDirectoryPath`
- `ensureFolderPath`
- `stripTrailingSlash`
- `normalizeExplorerPath`
- `normalizeMountPoint`

They mostly do similar things but with subtly different trailing-slash behavior.

I’d create one path module with explicit concepts:

```ts
type AbsolutePath = string;
type FolderPath = string;
type MountPoint = string;
type RelativePath = string;

normalizeAbsolutePath(value): AbsolutePath
normalizeMountPoint(value): MountPoint
normalizeFolderPath(value): FolderPath
normalizeFilePath(value): AbsolutePath
joinPath(base, child): AbsolutePath
isWithinPath(path, root): boolean
stripTrailingSlash(path): AbsolutePath
```

Then delete the many local duplicates.

This is probably the highest-value cleanup because many bugs in this system would be path-shape
bugs.

---

### 3. Replace global contributor registry with explicit composition

Current:

```ts
ensureBuiltInFileContributorsRegistered();
getRegisteredFileContributors();
```

This makes tests need resets and makes the runtime composition implicit.

I’d prefer:

```ts
createBackofficeFileSystem({
  orgId,
  contributors: createBackofficeFileContributors(env),
});
```

or:

```ts
const fileSystemFactory = new FileSystemFactory()
  .use(systemContributor)
  .use(workspaceContributor)
  .use(tmpContributor)
  .use(resendContributor)
  .use(eventsContributor);
```

Benefits:

- no global mutable registry
- easier tests
- easier per-environment mount sets
- clearer why `uploadFileContributor` exists but isn’t registered
- easier to make `/uploads` optional later

---

### 4. Make `/workspace` overlay explicit in naming

Currently `/workspace` is called `starterFileContributor`, but it may become writable and persistent
via Upload.

That is conceptually confusing.

I’d rename/restructure:

```txt
contributors/
  system.ts
  workspace/
    contributor.ts
    starter-layer.ts
    upload-write-layer.ts
    overlay.ts
  tmp.ts
  resend.ts
  events.ts
```

And names like:

```ts
workspaceFileContributor;
createStarterWorkspaceLayer;
createPersistentWorkspaceLayer;
createWorkspaceMountedFileSystem;
```

Instead of `starterFileContributor` being responsible for the full workspace mount.

---

### 5. Unify `stat` and `describeEntry`

Right now there’s a split between:

- `stat()` — mechanical metadata
- `describeEntry()` — richer UI metadata

But many places convert descriptor → stat or stat → descriptor.

I’d define one canonical internal model:

```ts
type FileSystemEntry = {
  path: AbsolutePath;
  kind: "file" | "folder";
  sizeBytes?: number;
  contentType?: string;
  mtime?: Date;
  mode?: number;
  title?: string;
  metadata?: Record<string, unknown>;
};
```

Then:

- `stat()` becomes a projection of `FileSystemEntry`
- explorer detail becomes another projection
- contributors can implement `getEntry(path)` and `listEntries(path)`

This would simplify `service.ts`, Upload tree building, static content helpers, and dynamic mounts.

---

### 6. Consolidate tree-building logic

There are multiple tree builders:

- static content tree in `contributors/content.ts`
- Upload tree in `contributors/upload.ts`
- Upload admin tree in `routes/backoffice/connections/upload/files.tsx`
- explorer tree in `files/service.ts`

I’d extract a shared generic tree utility:

```ts
buildTreeFromFlatFiles(files, {
  getPath,
  getDescriptor,
  markerStrategy?,
})
```

Then both Upload FS and Upload admin UI can reuse it, or at least share path/folder grouping logic.

This would reduce duplicated folder inference and sorting behavior.

---

### 7. Standardize errors

There is already `fs-errors.ts`, but a lot of code still throws plain messages:

```ts
throw new Error("Path not found.");
throw new Error("File not found.");
throw new Error("This mounted filesystem does not support ...");
```

I’d enforce:

```ts
FileSystemError {
  code: "ENOENT" | "EISDIR" | "ENOTDIR" | "EROFS" | "ENOTSUP" | "EINVAL";
  operation: string;
  path?: string;
}
```

Then consumers like download routes, codemode adapter, and overlay FS don’t need regex matching.

---

### 8. Decide whether `/uploads` is real or not

`uploadFileContributor` exists and defines `/uploads`, but built-ins don’t register it.

That’s confusing.

Options:

#### Option A — remove `/uploads` contributor from the main files package

If Upload is only a persistence layer for `/workspace`, keep it private/internal:

```txt
contributors/workspace/upload-layer.ts
```

#### Option B — register `/uploads` explicitly

Then the file explorer would show both:

```txt
/workspace   friendly workspace overlay
/uploads     raw upload-backed filesystem
```

But that should be a conscious product decision.

Right now it looks halfway implemented.

---

## Suggested phased cleanup

### Phase 1: Low-risk cleanup

- Move all path utilities into one module.
- Standardize `FileSystemError`.
- Rename `starterFileContributor` to `workspaceFileContributor`.
- Move workspace overlay code into `contributors/workspace/`.
- Remove duplicated local path helpers.

### Phase 2: Composition cleanup

- Replace global registry with explicit contributor arrays.
- Make built-in contributor creation request/env aware.
- Make `/uploads` decision explicit.
- Simplify tests by passing contributors directly.

### Phase 3: Model cleanup

- Introduce canonical `FileSystemEntry`.
- Replace `describeEntry` + `stat` conversion loops with `getEntry`.
- Make explorer service operate on that canonical entry model.

### Phase 4: Deduplicate Upload/tree logic

- Extract generic tree builder.
- Reuse between Upload FS and Upload admin UI where possible.
- Cache expensive dynamic listings per request, especially Upload, Resend, and Events.

---

## My recommended target architecture

```txt
files/
  core/
    filesystem.ts          # small interfaces
    entry.ts               # canonical FileSystemEntry
    errors.ts
    path.ts
    mount.ts
    master.ts

  contributors/
    system/
    workspace/
      starter-layer.ts
      upload-layer.ts
      overlay.ts
      contributor.ts
    tmp/
    resend/
    events/

  presentation/
    explorer-service.ts
    actions.ts
    preview.ts

  integrations/
    codemode.ts
    sandbox.ts
    automation-execution.ts
```

The important conceptual shift:

> Contributors should expose entries and content.  
> Master should only route.  
> Presentation should build UI.  
> Upload should be one storage backend, not mixed into explorer logic.

That would make the system much easier to reason about and easier to extend with future mounts like
GitHub, Telegram attachments, generated artifacts, or workflow outputs.
