# Backoffice filesystem breaking cleanup plan

> [!CAUTION] This is a **FULL BREAKING CHANGE**. It intentionally changes backoffice application
> behavior and filesystem paths.

## Target architecture

- [x] Remove the overlay filesystem completely.
- [x] Forbid overlapping mounted filesystems. Each filesystem must mount at a separate,
      non-overlapping location.
- [x] Remove the `starter` mount kind.
- [x] Keep starter automation content as static content mounted under `/starter`.
- [x] Keep the automation root as:

```ts
export const AUTOMATION_WORKSPACE_ROOT = "/starter/automations";
```

- [x] Use the name `static-starter` for the static starter contributor/module where practical.
- [x] Make `/workspace` a pure Upload-backed mount when Upload is configured, with no starter
      fallback.

## Expected removed behavior

- [x] Remove Upload-backed files overriding starter files at the same `/workspace` path.
- [x] Remove starter fallback behavior when an Upload-backed file is absent.
- [x] Remove deleting an Upload override to reveal starter content.
- [x] Remove starter “if missing” sandbox/bootstrap semantics.
- [x] Remove the `starter` root kind from UI/type surfaces.
- [x] Remove longest-prefix overlap behavior for nested mounts.
- [x] Remove the assumption that `/workspace` always contains starter automation defaults.
- [x] Remove `/workspace/automations` as the static starter automation location.

## 1. Delete overlay filesystem implementation

- [x] Delete `apps/backoffice/app/files/fs/overlay-file-system.ts`.
- [x] Delete `apps/backoffice/app/files/fs/overlay-file-system.test.ts`.
- [x] Remove all references to `createOverlayMountedFileSystem`.
- [x] Remove all references to overlay `readLayer` / `writeLayer` behavior.
- [x] Remove overlay-specific error text mentioning tombstones or starter read layers.
- [x] Confirm
      `rg "overlay|createOverlayMountedFileSystem|readLayer|writeLayer" apps/backoffice/app/files`
      has no production hits.

## 2. Remove `starter` mount kind

- [x] Update `apps/backoffice/app/files/types.ts`.
- [x] Change `FILE_ROOT_KINDS` from `[   "static",   "starter",   "upload",   "custom", ]` to
      `[   "static",   "upload",   "custom", ]`.
- [x] Keep `FileRootKind` derived from the reduced list.
- [x] Update `apps/backoffice/app/routes/backoffice/files/shared.tsx`.
- [x] Remove the `case "starter"` branch from `formatFileRootKind`.
- [x] Update any tests expecting `kind: "starter"`.
- [x] Confirm `rg 'kind: "starter"|case "starter"|\bstarter\b.*FileRootKind' apps/backoffice/app`
      only has intentional historical/test-cleanup references or none.

## 3. Replace `starter.ts` with `static-starter`

- [x] Rename or replace `apps/backoffice/app/files/contributors/starter.ts` with
      `apps/backoffice/app/files/contributors/static-starter.ts`.
- [x] Export a static starter mount with mount point `/starter`.
- [x] Use `kind: "static"`, not `kind: "starter"`.
- [x] Use an id such as `static-starter` or `starter`; prefer `static-starter` if this does not
      create excessive churn.
- [x] Use title `Starter` or `Static Starter`.
- [x] Mark it `readOnly: true`.
- [x] Mark it persistent/static; likely `persistence: "persistent"`.
- [x] Keep it backed by static content helpers from
      `apps/backoffice/app/files/contributors/content.ts`.
- [x] Ensure `createStaticStarterMountedFileSystem` reads from `/starter`.
- [x] Remove the `createFileSystem(ctx)` branch from the old starter contributor.
- [x] Remove imports from the old starter contributor for Upload and overlay helpers.

Remove from the old starter implementation:

- [x] `createOverlayMountedFileSystem` import.
- [x] `createUploadMountedFileSystem` import.
- [x] `isUploadConfigured` import.
- [x] `resolveBoundUploadProvider` import.
- [x] `FilesContext` type import if only needed for overlay logic.
- [x] `MountedFileSystemResolution` type import if only needed for overlay logic.
- [x] `canUsePersistentWorkspaceLayer`.
- [x] `describeWorkspaceRoot`.
- [x] `resolveStarterMountedFileSystem`.
- [x] Overlay-specific mount metadata overrides.

## 4. Update built-in contributors

- [x] Update `apps/backoffice/app/files/contributors/index.ts`.
- [x] Replace `starterFileContributor` import with `staticStarterFileContributor` or the chosen
      static-starter export.
- [x] Add `uploadFileContributor` to `BUILT_IN_FILE_CONTRIBUTORS` if `/workspace` should be the pure
      Upload-backed mount.
- [x] Ensure built-ins contain separate mounts only, likely:
  - [x] `/system`
  - [x] `/starter`
  - [x] `/workspace` when Upload is configured
  - [x] `/tmp`
  - [x] `/resend`
  - [x] `/events`
- [x] Ensure no built-in contributor attempts to mount at a child of another built-in contributor.

## 5. Make `/workspace` pure Upload-backed storage

- [x] Update `apps/backoffice/app/files/contributors/upload.ts`.
- [x] Decide whether to change the default Upload mount from `/uploads` to `/workspace`; recommended
      for continuity: `/workspace`.
- [x] If changing default, update `UPLOAD_FILE_MOUNT_ID` from `uploads` to `workspace` or similar.
- [x] If changing default, update `UPLOAD_FILE_MOUNT_POINT` from `/uploads` to `/workspace`.
- [x] If changing default, update `uploadFileMount.title` from `Uploads` to `Workspace`.
- [x] Keep `kind: "upload"`.
- [x] Keep `readOnly: false`.
- [x] Keep `persistence: "persistent"`.
- [x] Update `uploadFileMount.description` to say this is pure persistent org-scoped workspace
      storage through Upload, with no starter overlay/fallback.
- [x] Keep `createUploadMountedFileSystem` support for custom `mountPoint` if tests or callers still
      need it.
- [x] Keep `resolveUploadMountConfig` if sandbox bucket mounting still depends on it.
- [x] Update upload contributor tests in `apps/backoffice/app/files/contributors/upload.test.ts` for
      the new default mount.

## 6. Update starter static content names and copy

- [x] Update `apps/backoffice/app/files/content/starter.ts`.
- [x] Rename `STARTER_WORKSPACE_CONTENT` to `STATIC_STARTER_CONTENT` or `STARTER_CONTENT`.
- [x] Rename `STARTER_WORKSPACE_ROOT_DESCRIPTION` to `STATIC_STARTER_ROOT_DESCRIPTION` or
      `STARTER_ROOT_DESCRIPTION`.
- [x] Change README heading from “Workspace starter pack” to static starter language.
- [x] Replace references to `/workspace/automations` with `/starter/automations`.
- [x] Remove copy about Upload overrides.
- [x] Remove copy about layered optional Upload-backed overrides.
- [x] Remove copy about starter fallback source-of-truth semantics.
- [x] Keep docs that explain `/starter` is read-only static example/default automation content.

## 7. Move starter automation paths to `/starter`

- [x] Update `apps/backoffice/app/files/content/automations.ts`.
- [x] Change all manifest script paths from `/workspace/automations/scripts/...` to
      `/starter/automations/scripts/...`.
- [x] Change all `.slice("/workspace/".length)` calls to use `/starter/` or a constant.
- [x] Prefer defining a constant for the static starter root path.
- [x] Update comments saying paths are “absolute path under /workspace”.
- [x] Update `STARTER_AUTOMATION_SCRIPT_PATHS` to produce relative paths from `/starter`, not
      `/workspace`.
- [x] Confirm generated starter manifest contains `/starter/automations/scripts/*.cm.js` paths.

## 8. Change automation root to `/starter/automations`

- [x] Update `apps/backoffice/app/fragno/automation/catalog.ts`.
- [x] Set exactly:

```ts
export const AUTOMATION_WORKSPACE_ROOT = "/starter/automations";
```

- [x] Keep the constant name `AUTOMATION_WORKSPACE_ROOT` for now, despite the new path, unless doing
      a broader rename.
- [x] Verify derived constants become:
  - [x] `AUTOMATION_BINDINGS_MANIFEST_PATH = "/starter/automations/bindings.json"`
  - [x] `AUTOMATION_SCRIPTS_ROOT = "/starter/automations/scripts"`
- [x] Update path validation error messages in `catalog.ts` if they mention workspace in user-facing
      text.
- [x] Update tests in `apps/backoffice/app/fragno/automation/catalog.test.ts`.

## 9. Update automation UI and runtime copy

- [x] Update `apps/backoffice/app/routes/backoffice/automations/shared.tsx`.
- [x] Replace “Edit the underlying files through Backoffice Files under /workspace/automations” with
      `/starter/automations` or clarify read-only/static behavior.
- [x] Update `apps/backoffice/app/routes/backoffice/automations/data.ts` if any user-facing labels
      or script ids assume workspace semantics.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/automation-host.ts` path descriptions if
      needed.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/families/automations.ts` tool
      descriptions/examples from `/workspace/automations` to `/starter/automations`.
- [x] Update `apps/backoffice/app/fragno/pi/pi-shared.ts` references to `/workspace/automations`.
- [x] Update `apps/backoffice/app/routes/backoffice/connections/telegram/configuration.tsx`
      references to starter automation files under `/workspace`.
- [x] Update `apps/backoffice/app/files/content/system.ts` guidance references from
      `/workspace/automations` to `/starter/automations`.

## 10. Enforce non-overlapping mounts in `MasterFileSystem`

- [x] Update `apps/backoffice/app/files/master-file-system.ts`.
- [x] Add validation that rejects exact duplicate mount points.
- [x] Add validation that rejects ancestor/descendant mount overlaps.
- [x] Reject examples like `/workspace` and `/workspace/foo`.
- [x] Reject examples like `/system` and `/system/archive/deep`.
- [x] Apply validation in the constructor.
- [x] Apply validation in `mount(mount)`.
- [x] Keep synthetic parent directories for deep non-overlapping mounts, if desired.
- [x] Consider removing `#routingMounts` once overlaps are impossible.
- [x] If keeping `#routingMounts` temporarily, add tests proving overlaps are rejected and routing
      is deterministic.
- [x] Update `apps/backoffice/app/files/master-file-system.test.ts` tests that currently rely on
      longest-prefix overlapping routing.

## 11. Simplify `MasterFileSystem` routing after overlap removal

- [x] Replace longest-prefix routing with straightforward mount ownership checks if practical.
- [x] Remove assumptions that a child mount may shadow a parent mount.
- [x] Simplify or remove tests for nested mounted routes under an existing mount.
- [x] Preserve useful behavior where `/` and parent directories of deep standalone mounts can be
      synthetic.
- [x] Revisit `#isVirtualOnlyDirectory` and remove branches that only exist to protect parent/child
      mount overlap behavior.

## 12. Simplify sandbox bootstrap

- [x] Update `apps/backoffice/app/files/prepare-sandbox-filesystem.ts`.
- [x] Remove import of `createStarterMountedFileSystem` from the old starter contributor.
- [x] Remove `resolveBootstrapMounts` special-casing for `mount.kind === "starter"`.
- [x] Remove logic that seeds starter files before mounting a persistent `/workspace` bucket.
- [x] Remove `if (mount.kind === "starter")` if-missing write behavior in `materializeMountTree`.
- [x] Keep generic materialization for read-only static `/starter`.
- [x] Keep bucket mounting for persistent writable Upload-backed `/workspace`.
- [x] Review whether `await ensureDirectory(handle, "/workspace")` should remain unconditional.
- [x] Prefer creating only actual mount roots rather than always creating `/workspace`.
- [x] Update sentinel contents if expected roots change.

## 13. Simplify sandbox tests

- [x] Update `apps/backoffice/app/files/prepare-sandbox-filesystem.test.ts`.
- [x] Remove tests for “seeds starter files before mounting a persistent workspace bucket”.
- [x] Remove tests expecting starter files to be written before mounting `/workspace`.
- [x] Update expected roots to include `/starter`.
- [x] Update persistent bucket mount tests to treat `/workspace` as Upload-only.
- [x] Update error expectation “Upload mount configuration missing for '/workspace'” if behavior
      changes.
- [x] Keep tests proving static `/starter` materializes and Upload-backed `/workspace` mounts
      separately.

## 14. Update file exports

- [x] Update `apps/backoffice/app/files/index.ts`.
- [x] Remove exports of old starter workspace names if renamed:
  - [x] `STARTER_WORKSPACE_CONTENT`
  - [x] `STARTER_WORKSPACE_ROOT_DESCRIPTION`
- [x] Add exports for new static-starter names:
  - [x] `STATIC_STARTER_FILE_CONTRIBUTOR_ID`
  - [x] `STATIC_STARTER_FILE_MOUNT_ID`
  - [x] `STATIC_STARTER_FILE_MOUNT_POINT`
  - [x] `createStaticStarterMountedFileSystem`
  - [x] `staticStarterFileContributor`
  - [x] `staticStarterFileMount`
  - [x] `STATIC_STARTER_CONTENT` or chosen content export
  - [x] `STATIC_STARTER_ROOT_DESCRIPTION` or chosen description export
- [x] Keep old export aliases only if intentionally easing migration; otherwise remove them because
      this is a full breaking change.

## 15. Update explorer/service expectations

- [x] Update `apps/backoffice/app/files/service.ts` only if assumptions about starter/workspace
      paths exist.
- [x] Update `apps/backoffice/app/files/service.test.ts`.
- [x] Change expected mount list from `/system`, `/workspace`, `/tmp` to include `/starter` and
      conditionally `/workspace` when Upload is configured.
- [x] Remove tests named or scoped around “overlay-backed workspace files”.
- [x] Remove tests for read-only starter workspace under `/workspace`.
- [x] Add tests for read-only static starter under `/starter`.
- [x] Add tests for writable Upload-backed `/workspace` with no starter fallback.

## 16. Update starter contributor tests

- [x] Rename `apps/backoffice/app/files/contributors/starter.test.ts` to
      `apps/backoffice/app/files/contributors/static-starter.test.ts` if the module is renamed.
- [x] Update imports to `static-starter` names.
- [x] Expect mount point `/starter`.
- [x] Expect `kind: "static"`.
- [x] Expect read-only behavior.
- [x] Remove fallback-to-read-only-when-Upload-unavailable test; static starter is always read-only
      and independent of Upload.
- [x] Remove “layers persistent upload overrides” test entirely.
- [x] Remove “deleting override reveals starter file” assertions.
- [x] Keep tests reading README and automation manifest from `/starter`.

## 17. Update master filesystem tests

- [x] Update `apps/backoffice/app/files/master-file-system.test.ts`.
- [x] Remove or invert tests that register overlapping mount points.
- [x] Add tests that overlapping mount points throw during `createMasterFileSystem`.
- [x] Add tests that `master.mount(...)` rejects overlapping mount points.
- [x] Update standard mount display order expectations from `/system`, `/workspace` to include
      `/starter` if desired.
- [x] Update `STANDARD_MOUNT_POINT_ORDER` in `master-file-system.ts` from
      `["/system", "/workspace"]` to likely `["/system", "/starter", "/workspace"]`.

## 18. Update Upload tests

- [x] Update `apps/backoffice/app/files/contributors/upload.test.ts`.
- [x] If default Upload mount becomes `/workspace`, update default mount metadata expectations.
- [x] Keep custom mount tests if useful, but rename the test currently saying “can mount the
      upload-backed filesystem at /workspace” if `/workspace` becomes default.
- [x] Ensure directory marker tests still pass under `/workspace`.
- [x] Ensure `resolveUploadMountConfig` still works with `uploadProvider` metadata.

## 19. Update automation tests

- [x] Update `apps/backoffice/app/fragno/automation/catalog.test.ts` paths from
      `/workspace/automations` to `/starter/automations`.
- [x] Update `apps/backoffice/app/routes/backoffice/automations/data.test.ts` expected script paths
      and missing-script messages.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/automation-host.test.ts` where script paths
      should now be `/starter/automations` for static starter scripts.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/scripts-run-codemode.cloudflare.test.ts`
      where script/event fixtures should intentionally use either `/starter` for starter scripts or
      `/workspace` for user/persistent files.
- [x] Decide whether `scripts.run --script scripts/foo.sh` resolves to
      `/starter/automations/scripts/foo.sh`; with the required root constant, it should.

## 20. Update non-filesystem `/workspace` references carefully

Some `/workspace` references are not part of starter overlay behavior and may remain valid for user
writable workspace storage.

- [x] Review `apps/backoffice/app/sandbox/cloudflare-sandbox-manager.test.ts` and keep `/workspace`
      where it means generic sandbox writable workspace.
- [x] Review `apps/backoffice/app/routes/backoffice/dashboard-terminal.test.ts` and keep
      `/workspace` where it means shell cwd/user workspace.
- [x] Review automation-host tests using `/workspace/events/...`; decide if events are user-created
      persistent workspace files and can remain, or if they should move to `/starter`/`/events`.
- [x] Do not blindly replace all `/workspace` references; only replace starter automation/static
      defaults with `/starter`.

## 21. Update user-facing docs/guidance

- [x] Update `apps/backoffice/app/files/content/system.ts`.
- [x] Update `apps/backoffice/app/files/content/starter.ts`.
- [x] Update `apps/backoffice/app/routes/backoffice/automations/shared.tsx`.
- [x] Update `apps/backoffice/app/routes/backoffice/connections/telegram/configuration.tsx`.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/families/automations.ts` examples.
- [x] Update `apps/backoffice/app/fragno/pi/pi-shared.ts` guidance.
- [x] Search for stale text:

```sh
rg -n "/workspace/automations|starter workspace|overlay|override|fallback source of truth|starter read layer|tombstone" apps/backoffice/app
```

## 22. Confirm Upload admin UI remains separate

- [x] Review `apps/backoffice/app/routes/backoffice/connections/upload/`.
- [x] Confirm this UI still directly manages Upload records and is not expected to be the mounted
      filesystem explorer.
- [x] Avoid unnecessary changes to upload admin tree code unless names like `/uploads` leak into
      mounted filesystem assumptions.

## 23. Validate no stale overlay/starter-kind code remains

- [x] Run:

```sh
rg -n "createOverlayMountedFileSystem|overlay-file-system|readLayer|writeLayer" apps/backoffice/app
```

- [x] Run:

```sh
rg -n "kind: \"starter\"|case \"starter\"|FILE_ROOT_KINDS.*starter" apps/backoffice/app
```

- [x] Run:

```sh
rg -n "/workspace/automations" apps/backoffice/app
```

- [x] Run:

```sh
rg -n "STARTER_WORKSPACE|starter workspace|Workspace starter pack" apps/backoffice/app
```

- [x] Resolve or intentionally document any remaining hits.

## 24. Validation commands

- [x] Run backoffice typecheck through Turbo:

```sh
pnpm exec turbo types:check --filter=./apps/backoffice --output-logs=errors-only
```

- [x] Run backoffice tests through Turbo:

```sh
pnpm exec turbo test --filter=./apps/backoffice --output-logs=errors-only
```

- [x] Run lint:

```sh
pnpm run lint
```

- [x] If the app filter does not match the Turbo package naming, rerun with the correct package name
      or a broader relevant filter.
