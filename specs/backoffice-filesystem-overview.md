<!-- Extracted from Pi session: /Users/wilco/.pi/agent/sessions/--Users-wilco-dev-fragno.worktrees-wilco-backoffice-filesystems--/2026-06-06T11-50-44-896Z_019e9cc5-6da0-719c-bcdd-7083432fc1b8.jsonl -->

# Backoffice filesystem overview

Here’s the map of the “file system” architecture in `apps/backoffice`.

## Core concept

The app has a **mounted virtual filesystem** abstraction centered around:

- `IFileSystem` — generic filesystem API
- `MountedFileSystem` — mount-level filesystem plus UI/metadata capabilities
- `FileContributor` — plugin/registration unit that contributes a mount
- `MasterFileSystem` — router that combines all mounts into one namespace
- explorer/service/action layers — turn filesystem state into UI tree/detail/actions
- automation/codemode/sandbox adapters — consume the same filesystem in runtimes

Primary directory:

```txt
apps/backoffice/app/files/
```

---

## 1. Base interface: `IFileSystem`

File: `apps/backoffice/app/files/interface.ts`

`IFileSystem` is a broad async filesystem contract modeled after Node/POSIX-ish behavior.

Important methods:

```ts
readFile(path)
readFileBuffer(path)
readFileStream?(path)
writeFile(path, content)
appendFile(path, content)
exists(path)
stat(path)
mkdir(path)
readdir(path)
readdirWithFileTypes?(path)
rm(path)
cp(src, dest)
mv(src, dest)
resolvePath(base, path)
getAllPaths()
chmod(path, mode)
symlink(target, linkPath)
link(existingPath, newPath)
readlink(path)
lstat(path)
realpath(path)
utimes(path, atime, mtime)
```

This interface is used by:

- backoffice file explorer
- automation scripts
- bash/codemode state adapters
- sandbox bootstrap code
- tests and mock filesystem implementations

---

## 2. Mount metadata and contributor model

File: `apps/backoffice/app/files/types.ts`

### Mount metadata

```ts
type FileMountMetadata = {
  id: string;
  kind: "static" | "starter" | "upload" | "custom";
  mountPoint: string;
  title: string;
  readOnly: boolean;
  persistence: "ephemeral" | "persistent" | "session";
  description?: string;
  uploadProvider?: UploadProvider;
};
```

This describes how a mount appears in the UI and how it should behave.

### `MountedFileSystem`

Extends `IFileSystem` and adds:

```ts
capabilities: {
  writeFile: boolean;
  mkdir: boolean;
  rm: boolean;
};

describeEntry?(path, stat?): FileEntryDescriptor | null;
```

`describeEntry` is important: it lets a mount provide rich UI metadata without relying purely on
`stat`.

### `FileContributor`

A contributor is the registration unit:

```ts
interface FileContributor extends FileMountMetadata, MountedFileSystemInput {
  createFileSystem?(ctx: FilesContext): MountedFileSystemResolution | null;
}
```

A contributor can either directly implement filesystem methods or provide a request/org-bound
`createFileSystem`.

---

## 3. Normalization layer

File: `apps/backoffice/app/files/mounted-file-system.ts`

`normalizeMountedFileSystem(input, { readOnly })` takes a partial mount implementation and returns a
full `MountedFileSystem`.

It supplies:

- fallback `readFile` from `readFileBuffer`
- fallback `readFileBuffer` from `readFile`
- fallback `exists` from `stat`
- fallback `readdirWithFileTypes` from `readdir + stat`
- fallback `appendFile`
- fallback `cp`/`mv`
- unsupported-operation throwers
- read-only enforcement for capabilities

This is what allows contributors to implement only the subset they need.

---

## 4. Registry and built-ins

Files:

- `apps/backoffice/app/files/registry.ts`
- `apps/backoffice/app/files/contributors/index.ts`

The registry is global-ish:

```ts
registerFileContributor(contributor);
getRegisteredFileContributors();
resetFileContributorsForTest();
```

Built-ins are registered via:

```ts
ensureBuiltInFileContributorsRegistered();
```

Current built-ins:

```ts
staticFileContributor       -> /system
starterFileContributor      -> /workspace
tmpFileContributor          -> /tmp
resendFileContributor       -> /resend
automationHooksFileContributor -> /events
```

Notably, `uploadFileContributor` exists but is **not** in the current built-in list. Upload-backed
storage is instead used by `/workspace` as a persistent overlay when Upload is configured.

---

## 5. Master filesystem

File: `apps/backoffice/app/files/master-file-system.ts`

`MasterFileSystem` is the central router. It implements `IFileSystem` and delegates operations to
the correct mount.

### Routing

It uses **longest-prefix match**:

```txt
/workspace/foo.txt -> /workspace mount
/system/readme.md  -> /system mount
/events/2026...    -> /events mount
```

Mounts are sorted separately for:

- display order
- routing order

Display order prioritizes:

```ts
/system
/workspace
then others
```

### Synthetic directories

`MasterFileSystem` synthesizes `/` and parent directories implied by mount points.

Example if mounts include:

```txt
/system
/workspace
/project/generated/deep
```

Then `/`, `/project`, `/project/generated` can appear as virtual directories even if no mount owns
them directly.

### Mutation constraints

`MasterFileSystem` enforces:

- cannot write to read-only mounts
- cannot write into virtual-only routing dirs
- cross-mount `cp`, `mv`, hard-link are rejected

Example:

```ts
cp("/workspace/a", "/tmp/a");
```

throws because cross-mount copy is unsupported.

---

## 6. Creating an org filesystem

File: `apps/backoffice/app/files/create-file-system.ts`

Main entrypoint:

```ts
createOrgFileSystem({ orgId, env, automationHookQueue? })
```

It wires Cloudflare DO-backed runtimes into `FilesContext`:

- Upload DO config/runtime if `env.UPLOAD`
- Resend DO runtime
- Automations DO runtime for durable hook queues

Then calls:

```ts
createMasterFileSystem({
  orgId,
  origin,
  uploadConfig,
  uploadRuntime,
  resendRuntime,
  durableHooksRuntimes,
});
```

This is used from:

- file explorer routes
- automation DO
- Pi runtime
- dashboard/environment pages
- automation data loading

---

## 7. Built-in implementations

### `/system`: static read-only files

File: `apps/backoffice/app/files/contributors/static.ts`

Backed by:

```ts
SYSTEM_FILE_CONTENT;
```

from `apps/backoffice/app/files/content/system.ts`.

Characteristics:

- mount kind: `static`
- read-only
- persistent
- uses `content.ts` helpers to build trees and read artifacts

---

### `/workspace`: starter files, optionally Upload-backed

File: `apps/backoffice/app/files/contributors/starter.ts`

Base layer:

```ts
STARTER_WORKSPACE_CONTENT;
```

from `content/starter.ts`.

By default:

- read-only
- session persistence
- static starter content

If Upload is configured, `/workspace` becomes an overlay:

```ts
readLayer  = starter filesystem
writeLayer = upload mounted filesystem at /workspace
```

Then:

- writable
- persistent
- Upload-backed files override starter files
- deleting a persistent override reveals the starter file again
- deleting read-layer starter-only files is not supported because tombstones do not exist yet

This is the most important implementation because it is the durable workspace used by automations
and scripts.

---

### Overlay filesystem

File: `apps/backoffice/app/files/fs/overlay-file-system.ts`

Combines:

```ts
readLayer + writeLayer;
```

Behavior:

- reads prefer write layer, then read layer
- directory listings merge both layers
- write layer entries shadow read layer entries
- cannot overwrite read-layer directory with a file
- cannot create a directory where read layer has a file
- cannot delete read-layer-only paths because tombstones are not supported

Used currently by `/workspace`.

---

### Upload-backed filesystem

File: `apps/backoffice/app/files/contributors/upload.ts`

Implements a filesystem on top of the Upload fragment runtime.

Important behavior:

- file paths map to Upload `fileKey`
- folders are represented through inferred prefixes and explicit directory marker files
- read/write/delete go through `/api/upload/...` routes using `ctx.uploadRuntime.fetch`
- supports:
  - `readFile`
  - `readFileBuffer`
  - `readFileStream`
  - `writeFile`
  - `mkdir`
  - `rm`
  - `chmod`
  - `utimes`
- stores filesystem metadata in upload record metadata under:

```ts
__docsFs;
```

with:

```ts
mode;
mtime;
```

It can mount at `/uploads`, but in practice `/workspace` uses it as the write layer.

---

### `/tmp`: in-memory scratch

File: `apps/backoffice/app/files/contributors/tmp.ts`

Backed by `just-bash`’s `InMemoryFs`.

Characteristics:

- writable
- ephemeral
- custom mount
- created fresh per filesystem creation

---

### `/resend`: read-only email snapshots

File: `apps/backoffice/app/files/contributors/resend.ts`

Backed by Resend runtime.

Characteristics:

- mount: `/resend`
- read-only
- ephemeral
- one Markdown file per Resend thread
- file content is generated dynamically from thread messages

Example path shape:

```txt
/resend/<encoded-thread-id>.md
```

---

### `/events`: durable hook event outputs

File: `apps/backoffice/app/files/contributors/durable-hooks.ts`

Created via:

```ts
createDurableHooksFileContributor(...)
```

Built-in instance:

```ts
automationHooksFileContributor;
```

Mount:

```txt
/events
```

Characteristics:

- read-only
- ephemeral
- terminal durable hook queue entries only
- organized by UTC day
- completed hooks become JSON files
- failed hooks become text files

Example:

```txt
/events/2026-06-06/2026-06-06T12:00:00.000Z_hook-id.json
/events/2026-06-06/2026-06-06T12:00:00.000Z_hook-id-failed.txt
```

---

## 8. Static content helper

File: `apps/backoffice/app/files/contributors/content.ts`

Shared by `/system` and starter `/workspace`.

It turns:

```ts
Record<string, string | Uint8Array>;
```

into a tree of `FileEntryDescriptor`s.

Provides:

- `buildContentTree`
- `listContentChildren`
- `listContentChildNames`
- `listContentDirents`
- `findContentEntry`
- `statContentEntry`
- `readContentText`
- `readContentBuffer`

---

## 9. Explorer service layer

File: `apps/backoffice/app/files/service.ts`

This turns `MasterFileSystem` state into UI-friendly data.

Important functions:

```ts
listFilesTree(master);
listFilesChildren(master, path);
getFilesNodeDetail(master, path);
resolveFilesTarget(master, path);
```

It resolves:

- root nodes
- folders
- files
- details
- text previews
- capabilities
- metadata
- size/date/content type fields

It reads text content only for likely text files.

Text detection uses:

- content type
- extension patterns like `.md`, `.txt`, `.json`, `.ts`, `.tsx`, `.sh`, etc.

---

## 10. Explorer route layer

Files:

- `apps/backoffice/app/routes/backoffice/files/data.ts`
- `apps/backoffice/app/routes/backoffice/files/explorer.tsx`
- `apps/backoffice/app/routes/backoffice/files/download.ts`

### Loader

Creates org filesystem:

```ts
createBackofficeFilesFileSystem(...)
```

which calls:

```ts
createOrgFileSystem({ orgId, env });
```

Then:

```ts
listFilesTree(fileSystem)
getFilesNodeDetail(fileSystem, selectedPath)
expandTreeAlongSelection(...)
```

### Actions

File action intents:

```ts
create - folder;
delete write - text;
```

Handled through:

```ts
performFilesAction(...)
```

### Download

`download.ts`:

- authenticates user/org
- stats target path
- only allows files
- prefers `readFileStream`
- falls back to `readFileBuffer`
- caps buffered fallback at 10 MiB

---

## 11. File actions

File: `apps/backoffice/app/files/actions.ts`

`performFilesAction` routes UI mutations to mount methods.

Behavior:

### Create folder

Allowed only on root/folder targets, if:

```ts
!mount.readOnly && mount.fs.capabilities.mkdir;
```

Then calls:

```ts
target.mount.fs.mkdir(path, { recursive: true });
```

### Write text

Allowed only on file targets, if:

```ts
!mount.readOnly && mount.fs.capabilities.writeFile;
```

Then calls:

```ts
target.mount.fs.writeFile(path, content, { encoding: "utf-8" });
```

### Delete

Allowed only on non-root targets, if:

```ts
!mount.readOnly && mount.fs.capabilities.rm;
```

Then calls:

```ts
target.mount.fs.rm(path, {
  recursive: target.isFolderPath,
  force: true,
});
```

---

## 12. Automation interaction

Files:

- `apps/backoffice/app/fragno/automation/catalog.ts`
- `apps/backoffice/app/fragno/runtime-tools/automation-host.ts`
- `apps/backoffice/app/fragno/automation/engine/execution-file-system.ts`

Automations consume `IFileSystem`.

### Catalog

`loadAutomationCatalog(fileSystem)` reads automation manifest/scripts from the filesystem.

Fallback:

```ts
createMinimalFileSystem(orgId);
```

creates a `MasterFileSystem` without Upload config.

### Execution filesystem

`createAutomationExecutionFileSystem` takes a `MasterFileSystem` and mounts extra runtime mounts:

```txt
/context
/dev optional
```

`/context` contains:

```txt
/context/event.json
/context/env.json optional
```

`/dev` contains:

```txt
/dev/null
/dev/zero
```

The execution filesystem is still a `MasterFileSystem`, but with contextual session mounts added.

### Script runner

`scripts.run` expects a `MasterFileSystem` for nested script execution. It reads script/event files
from the filesystem, then executes another automation.

---

## 13. Codemode adapter

File: `apps/backoffice/app/fragno/codemode/master-file-system-state.ts`

`BackofficeStateFileSystem` adapts `IFileSystem` to Cloudflare shell/codemode’s `FileSystem`
interface.

Key translations:

```ts
readFile          -> IFileSystem.readFile
readFileBytes     -> IFileSystem.readFileBuffer
writeFile         -> IFileSystem.writeFile
writeFileBytes    -> IFileSystem.writeFile
stat/lstat        -> converts FsStat to shell stat shape
glob              -> materializes path skeleton into InMemoryFs, then delegates glob
```

It also converts missing-path errors into shell-style `ENOENT` errors.

---

## 14. Sandbox bootstrap

File: `apps/backoffice/app/files/prepare-sandbox-filesystem.ts`

This materializes the virtual filesystem into a sandbox handle.

Important behavior:

- skips if bootstrap sentinel exists:

```txt
/.fragno/files-bootstrap.json
```

- persistent writable mounts must be resolvable as bucket mounts
- bucket-backed mounts are mounted into sandbox
- non-bucket mounts are materialized by walking their tree
- starter mounts that are bucket-backed still materialize starter content as bootstrap defaults
- ensures `/workspace` exists

This bridges the virtual filesystem into a real/sandboxed filesystem environment.

---

## 15. Upload connection files UI is separate

Files under:

```txt
apps/backoffice/app/routes/backoffice/connections/upload/
```

represent the Upload fragment admin UI, not the same mounted filesystem architecture.

That UI works directly with upload APIs and builds its own tree:

```ts
buildUploadFileTree(...)
```

It overlaps conceptually with files, but it is not using `MasterFileSystem`.

Relationship:

- Upload admin UI manages raw upload records/providers.
- Mounted filesystem uses Upload runtime as a backing store, primarily for `/workspace`.

---

## 16. Overall interaction graph

```txt
Cloudflare env / DOs
   |
   v
createOrgFileSystem
   |
   v
createMasterFileSystem
   |
   +-- registry contributors
   |     |
   |     +-- /system static content
   |     +-- /workspace starter or overlay(starter + upload)
   |     +-- /tmp in-memory
   |     +-- /resend runtime-generated markdown
   |     +-- /events durable hook queue files
   |
   v
MasterFileSystem
   |
   +-- Backoffice files explorer
   |     +-- listFilesTree
   |     +-- getFilesNodeDetail
   |     +-- performFilesAction
   |     +-- download route
   |
   +-- Automation catalog/runtime
   |     +-- reads manifest/scripts
   |     +-- execution fs adds /context and /dev
   |
   +-- Codemode adapter
   |
   +-- Sandbox bootstrap
```

---

## Key takeaways

1. `IFileSystem` is the universal filesystem interface.
2. `MountedFileSystem` is the mount-level abstraction with UI capabilities and descriptors.
3. `FileContributor` is the plugin model.
4. `MasterFileSystem` is the combined router and synthetic namespace.
5. `/workspace` is the central user-facing writable filesystem when Upload is configured.
6. Upload storage is reused as the persistence layer, but the Upload admin UI is separate.
7. Automation, codemode, and sandbox code all consume the same filesystem abstraction.
8. The architecture is intentionally portable: static, dynamic, ephemeral, persistent, and
   runtime-generated files all appear under one virtual tree.
