# Plan: Marketplace artifacts through organization Automations workflows

## Goal

Add Marketplace artifacts without turning Marketplace into a package manager or duplicating Upload
metadata.

A Marketplace version points at a directory in a named Upload Durable Object. Upload remains the
source of truth for the files and their metadata. Publication and ingestion are durable workflows in
the organization Automations Durable Object that owns the operation.

The Marketplace singleton remains a catalog. It does not own workflow execution or organization
ingestion state.

## Core decisions

- Each listing uses one deterministic named Upload object:

  ```ts
  objects.upload.forName(marketplaceArtifactUploadName(listingId));
  ```

- Each semantic version gets a stable directory in that Upload object.
- The Marketplace schema is the artifact manifest. Each published `marketplace_version` row stores
  its directory.
- A manifest response is a projection containing `versions: Array<{ version, directory }>`.
- There is no `manifest.json` in Upload.
- Upload file records are authoritative for file keys, checksums, content types, sizes, status, and
  filesystem metadata.
- Publishing to Marketplace runs as a workflow in the requesting organization's Automations object.
- Ingesting from Marketplace runs as a workflow in the requesting organization's Automations object.
- `marketplace_ingestion` is stored in that organization Automations database, not the Marketplace
  singleton.
- An ingestion can target the organization's workspace, one of its projects, or an authorized user
  workspace. The organization Automations object remains the process and persistence owner.
- The named Upload object is derived from the owner-qualified listing ID as
  `marketplace/listings/${hex(utf8(listingId))}`; no additional pointer record is required.
- There is no ZIP, generated package, per-file Marketplace table, installation receipt, or Upload
  manifest file in the first implementation.

## Storage layout

Version directories live directly at the named Upload object root. There is no top-level `versions/`
directory and no manifest file.

For listing `telegram-test-command` with versions `1.0.0` and `2.0.0`:

```text
Upload object: named/marketplace/listings/73797374656d2374656c656772616d2d746573742d636f6d6d616e64

1.0.0/automations/telegram-test-command.workflow.js
1.0.0/other-file.json
2.0.0/automations/telegram-test-command.workflow.js
```

The complete recursive contents of a version's directory make up that artifact version.

A directory is published by:

1. writing all files into the version directory;
2. setting the Marketplace version's `artifactDirectory` and publishing it in one Marketplace
   transaction.

Marketplace publication does not hash or re-verify the files. Upload remains responsible for its
normal file metadata.

## Marketplace data model

The existing normalized version table is the manifest. Add one nullable column:

```ts
marketplace_version: {
  // existing fields
  version: string;
  status: "draft" | "published";
  artifactDirectory: string | null;
}
```

Draft versions may have no directory. A published artifact version must have one. Once published,
`artifactDirectory` cannot change.

The named Upload object does not need to be stored because it is derived from the owner-qualified
listing ID:

```ts
const uploadName = `marketplace/listings/${bytesToHex(utf8(listing.id))}`;
```

When a caller needs the complete manifest, Marketplace projects its normalized rows:

```ts
{
  uploadName:
    "marketplace/listings/73797374656d2374656c656772616d2d746573742d636f6d6d616e64",
  versions: [
    { version: "1.0.0", directory: "1.0.0" },
    { version: "2.0.0", directory: "2.0.0" },
  ],
}
```

There is no JSON manifest column and no additional manifest table. `marketplace_version` already has
the required version identity and publication lifecycle, so adding another stored representation
would duplicate it.

The Marketplace database does not store:

- file paths;
- file counts;
- file sizes;
- file checksums;
- destination paths;
- ingestion state.

Those facts already belong to Upload or the organization Automations object.

## Automations ingestion data model

Add `marketplace_ingestion` to `automationFragmentSchema`.

The table does not need `orgId` because it lives inside an organization-scoped Automations Durable
Object. It does need the destination scope because one organization can ingest the same listing into
its organization workspace, project workspaces, and authorized user workspaces independently.

```ts
type MarketplaceIngestionTargetScope =
  | { kind: "org"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string }
  | { kind: "user"; userId: string };

{
  id: string; // deterministic targetKey + listingSlug
  targetKey: string;
  targetScope: MarketplaceIngestionTargetScope;
  listingSlug: string;
  version: string;
}
```

Use one ingestion per listing and destination scope within the organization. The fixed destination
root is `/workspace`, so no arbitrary destination field is needed initially.

The row represents only the last successfully ingested version. The workflow fragment already owns
execution status, errors, retries, start/completion times, and history; duplicating those fields in
`marketplace_ingestion` would create competing process state.

The workflow upserts `version` only after the complete source directory has been copied and
verified. A failed update leaves the existing row unchanged.

Use a deterministic workflow instance ID derived from organization, target, listing, and requested
version. This keeps workflow lookup and idempotency in Workflows without adding a
`workflowInstanceId` column to the ingestion row.

Suggested index:

- `targetKey, id` for listing a destination's ingestions.

The deterministic primary ID already enforces one row per target and listing.

## Workflow ownership

Add two built-in workflow definitions to `createAutomationsRuntime`:

```text
marketplace-publish
marketplace-ingest
```

These are internal platform workflows. They are not workspace-authored automation scripts and do not
need routes in the user automation router.

The workflow configuration receives:

- the owning organization scope;
- `BackofficeRuntimeServices` / object registry;
- the filesystem resolver for authorized destination scopes;
- access to the local Automation fragment for ingestion state.

Marketplace publication and ingestion RPCs are exposed on organization-scoped Automations objects.
They reject singleton, user, and project Automations scopes for these operations.

### Publication ownership

A publication workflow runs in the requesting organization's Automations object. It writes to the
global named Upload object and then mutates the Marketplace singleton with explicit listing-owner
identity.

The listing owner may still be `system`, `org`, `project`, or `user`; that is separate from the
organization that owns the publication process. The request boundary must prove that the actor and
organization may publish for that owner.

Bundled Fragno entries use the same workflow. `internal.marketplace.push` calls
`requestStaticMarketplacePublications()` on the current managed organization Automations object.
That RPC owns the iteration over `STATIC_MARKETPLACE_ENTRIES`, while each bundled entry retains its
explicit `system` listing owner. Supplying `system` ownership remains restricted to the hidden
internal tool.

### Ingestion ownership

An ingestion workflow runs in the requesting organization's Automations object. Its input contains a
previously authorized destination scope belonging to that organization. The organization Automations
database owns both the workflow history and the `marketplace_ingestion` row.

No ingestion record is written to the Marketplace singleton or a project/user Automations object.

## Upload integration

Do not add parallel private read, list, and write APIs. The Upload fragment already owns those
operations.

Publication and ingestion workflows should use the existing Upload routes/filesystem implementation
against an explicitly selected named Upload object. Extend the Upload filesystem adapter with an
object override if necessary:

```ts
createUploadFileSystem(context, {
  object: objects.upload.forName(marketplaceArtifactUploadName(listingId)),
  provider: "database",
  mountPoint: "/",
});
```

Use existing Upload behavior for:

- writing artifact files;
- reading artifact bytes;
- recursively listing a directory;
- retrieving checksums, sizes, content types, and filesystem metadata.

If an existing Backoffice projection drops checksum information, fix that projection instead of
creating another storage API.

No new Upload RPC is required. The Marketplace publication transaction is the commit operation:

- before publication, the workflow writes the version directory;
- publication atomically stores `artifactDirectory` on the version and changes it to `published`;
- after publication, normal publication requests return the published state without inspecting or
  rewriting files.

Use a deterministic publication workflow instance ID derived from listing and version. Workflow
instances already live inside an organization-scoped Automations object, so the organization does
not need to be repeated in the ID.

Named Marketplace Upload objects remain internal. Browser clients do not receive direct mutation
access to them.

## Static artifact source

Static entries remain directly imported application code. There is no runtime filesystem discovery.

```ts
{
  slug: "telegram-test-command",
  version: "1.0.0",
  metadata: { ... },
  files: {
    "automations/telegram-test-command.workflow.js":
      TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
  },
}
```

The `files` object is publication input only. It is not serialized into Marketplace or another
manifest structure.

Move the Telegram workflow source into one canonical module and consume that source from both:

- starter workspace content;
- the static Marketplace entry.

## Publication workflow

`marketplace-publish` receives a listing/version plus a concrete artifact source known to the
publisher runtime.

For bundled entries, the workflow receives the static registry identity and resolves the directly
imported entry when it executes. Publication requests do not load, hash, or pass the file contents.

Workflow steps:

1. **Validate publication request**
   - Validate slug and semantic version.
   - Normalize every relative artifact path.
   - Reject absolute paths, empty paths, `.`/`..`, and duplicate paths.
   - Resolve the explicit Marketplace owner.

2. **Reserve listing/version**
   - Create or retrieve the Marketplace draft listing.
   - Verify that the existing listing owner matches the requested owner.
   - Create or retrieve the draft semantic version.
   - Use the semantic version itself as the default `artifactDirectory`, for example `1.0.0`.
   - Refuse an already-published version unless its stored directory matches.

3. **Resolve source Upload object and directory**
   - Derive the Upload name from the owner-qualified listing ID.
   - Use `objects.upload.forName(marketplaceArtifactUploadName(listingId))`.
   - Write beneath the selected `artifactDirectory`.

4. **Write artifact files**
   - Write files in stable path order through the existing Upload filesystem.
   - Workflow retries may write the same target paths again.
   - Do not calculate a source fingerprint or compare Upload checksums.

5. **Publish the artifact version**
   - In one Marketplace transaction, set `artifactDirectory`, publish the version, and promote it to
     the listing's latest version.
   - Retrying an already-published version with the same directory is a no-op.
   - A published version's directory cannot change.

6. **Return publication result**
   - Return the listing ID, slug, version, and workflow instance ID.

If the workflow stops after writing files but before publishing Marketplace metadata, retrying
continues safely. Unreferenced draft directories can be cleaned up later, but cleanup is not
required for the first vertical slice.

## Ingestion workflow

`marketplace-ingest` receives:

```ts
{
  targetScope: MarketplaceIngestionTargetScope;
  listingSlug: string;
  version?: string; // defaults to latest published version
}
```

The authenticated request boundary authorizes `targetScope` before creating the workflow. The
organization Automations object additionally requires organization and project targets to carry its
own `orgId`. User targets require verified membership/management permission in that organization.
The workflow treats this validated scope as an immutable input snapshot.

Workflow steps:

1. **Resolve published artifact**
   - Read the requested or latest published Marketplace version.
   - Require its `artifactDirectory`.
   - Derive the named Upload object as `marketplace/${listingSlug}`.

2. **List source files**
   - List every ready Upload file beneath `artifactDirectory`.
   - Require at least one file.
   - Derive workspace-relative paths by stripping the directory prefix.
   - Validate every derived path before any target write.

3. **Plan target writes**
   - Resolve the target scope's `/workspace` filesystem through the organization Automations
     runtime.
   - For an absent target file, plan a create.
   - For a target file with the same checksum as the source Upload record, plan a no-op.
   - For a different existing file, fail with a conflict in the initial implementation.

4. **Copy files**
   - Read bytes from the named source Upload object.
   - Write to `/workspace/<relative source path>`.
   - Preserve content type and applicable filesystem mode metadata.
   - Copy in stable path order with idempotent workflow step names.

5. **Verify target Upload metadata**
   - Re-read the destination Upload records through the scoped filesystem/Upload object.
   - Compare target checksums and sizes with the source Upload records.

6. **Record successful ingestion**
   - Upsert `{ targetKey, targetScope, listingSlug, version }` in one Automations transaction.
   - Do this only after target verification succeeds.

If the workflow fails, the ingestion row is not changed. Workflow status, error details, timestamps,
and retry history remain available from the Workflows fragment. No separate receipt file or process
state is required.

## Update and out-of-date behavior

### Cheap out-of-date detection

Out-of-date status does not require a file scan.

1. List organization-local `marketplace_ingestion` rows, optionally filtered by `targetKey`.
2. Batch-fetch latest published versions for those slugs from Marketplace.
3. Compare:

```ts
ingestion.version !== marketplace.latestPublishedVersion;
```

Add a Marketplace batch read rather than making one RPC per slug:

```ts
getLatestPublishedVersions({ slugs }): Promise<Record<string, string | null>>;
```

Do not persist an `outdated` boolean. It is a projection of local ingestion version and global
Marketplace version.

### Safe updates without a per-file manifest

A later update workflow can derive all required information from Upload directories:

- list files from the previously ingested version directory;
- list files from the requested version directory;
- inspect current target Upload metadata.

Rules:

- target matches the old source checksum: safe to replace or delete;
- target already matches the new source checksum: no-op;
- target differs from both: local modification conflict;
- file exists only in the old source directory and is unchanged locally: safe to remove;
- file exists only in the new source directory: safe to create if the target is absent.

This keeps update behavior possible without storing file lists in Marketplace or Automations.

## Public and authenticated boundaries

Public Fragno routes remain metadata-only:

- `GET /listings`
- `GET /listings/:slug`

Public version detail may expose only whether an artifact is available. It should not expose generic
mutation access to the named Upload object.

Authenticated Backoffice actions perform authorization before calling Automations RPCs:

- publish action validates that the actor and organization can publish for the selected owner scope;
- ingest action validates that the actor can manage the requested organization/project/user target;
- both actions call `objects.automations.forOrg(orgId)`;
- ingestion passes the validated target scope as an immutable workflow input;
- the organization Automations object rejects target scopes that do not belong to that organization.

Candidate Automations RPCs:

```ts
requestStaticMarketplacePublications(): Promise<MarketplaceStaticPublicationResult>;
requestMarketplaceIngestion(input): Promise<MarketplaceIngestionRequestResult>;
getMarketplaceIngestion(input): Promise<MarketplaceIngestionRecord | null>;
listMarketplaceIngestions(input): Promise<MarketplaceIngestionPage>;
```

## Vertical slices

Each slice should leave one complete production path working and tested. Avoid building parallel
manifest infrastructure before a workflow uses it.

### Slice 1: Publish the Telegram artifact through an Automations workflow

Deliver the first complete publication path.

- [x] Add nullable `artifactDirectory` to `marketplace_version`.
- [x] Add the Marketplace manifest projection:
      `{ uploadName, versions: Array<{ version, directory }> }`.
- [x] Define canonical named Upload names and default root-level version directories.
- [x] Use the semantic version itself as the default directory; do not add a `versions/` parent.
- [x] Extract `TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE` into one canonical source module.
- [x] Extend the Upload filesystem adapter to target an explicit named Upload object.
- [x] Preserve checksum fields in the existing Upload file projection.
- [x] Add `marketplace-publish` to the built-in Automations workflow registry.
- [x] Write the static files using the existing Upload filesystem.
- [x] Publish by setting `artifactDirectory` and version status in one Marketplace transaction.
- [x] Change `internal.marketplace.push` to start the organization-owned workflow.
- [x] Use a deterministic workflow instance ID for listing and version within the organization
      Automations object.
- [x] Make repeated pushes return the existing published state without inspecting artifact files.

Acceptance:

- `internal.marketplace.push` publishes `telegram-test-command@1.0.0` through Automations.
- Files are stored under `1.0.0/` in the deterministic named Upload object.
- The Marketplace manifest projection returns `{ version: "1.0.0", directory: "1.0.0" }`.
- Upload contains no manifest file.

### Slice 2: Ingest one Marketplace version into an organization workspace

Add the first complete consumer path.

- [ ] Add the lean `marketplace_ingestion` table to Automations.
- [ ] Add successful-ingestion upsert, list, and get services.
- [ ] Add `marketplace-ingest` to the built-in Automations workflow registry.
- [ ] Add an organization-scoped Automations RPC to request ingestion.
- [ ] Add an authenticated Backoffice action on Marketplace detail.
- [ ] Read `artifactDirectory` from the selected published Marketplace version.
- [ ] Derive the source Upload object from the owner-qualified listing ID.
- [ ] List and copy every source-directory file into the organization `/workspace`.
- [ ] Reject conflicting existing files.
- [ ] Verify destination Upload metadata before upserting the ingestion version.
- [ ] Show ingestion version from Automations and process status from Workflows.

Acceptance:

- One click ingests the Telegram workflow into an organization workspace.
- Automations records only the successful `{ target, listingSlug, version }` state.
- Marketplace stores no ingestion or per-file state.

### Slice 3: Support project and user destination scopes

Generalize destination routing while retaining organization workflow ownership.

- [ ] Extend ingestion input with authorized project and user target scopes.
- [ ] Resolve project and user `/workspace` filesystems from the organization workflow.
- [ ] Generalize fixed database-backed Upload namespace initialization where required.
- [ ] Key ingestion rows by `targetKey + listingSlug`.
- [ ] Reject project targets from another organization.
- [ ] Verify user targets are manageable by the owning organization.
- [ ] Add organization, project, and user destination scenarios.

Acceptance:

- One organization-owned workflow can ingest into every supported destination.
- Each destination has independent ingestion state inside the organization Automations database.

### Slice 4: Surface out-of-date ingestions

Add update visibility without mutating existing copies.

- [ ] Add `getLatestPublishedVersions({ slugs })` to Marketplace.
- [ ] List Marketplace ingestions from organization Automations, filterable by target.
- [ ] Join the two reads in Backoffice loaders.
- [ ] Show ingested version, latest version, and derived out-of-date state.
- [ ] Test publishing `1.0.0`, ingesting it, publishing `2.0.0`, and observing the old ingestion as
      out of date.

Acceptance:

- Out-of-date state is derived without another stored boolean or reconciliation table.

### Slice 5: Safe version updates

Use Upload metadata from the old source, new source, and destination.

- [ ] Extend ingestion requests to update an existing ingestion.
- [ ] Read old and new `artifactDirectory` values from Marketplace.
- [ ] List old and new source directories from Upload.
- [ ] Plan creates, replacements, no-ops, and removals by checksum.
- [ ] Reject locally modified files.
- [ ] Leave the previous ingestion version unchanged if the workflow fails.
- [ ] Add clean-update, removed-file, local-conflict, and retry scenarios.

Acceptance:

- Unmodified ingestions update durably.
- User changes are never silently overwritten or deleted.

### Slice 6: General publisher uploads

Generalize the proven static publication workflow.

- [ ] Add workflow-specific draft artifact staging.
- [ ] Let an authorized publisher upload files through the requesting organization's Automations
      process.
- [ ] Finalize into a new root-level version directory.
- [ ] Publish by setting `artifactDirectory` in the existing Marketplace version row.
- [ ] Keep direct named Upload mutation unavailable to browser clients.
- [ ] Reuse the same publication invariants as bundled static entries.

Acceptance:

- Static and publisher-supplied artifacts use the same Upload layout and Marketplace version model.

## Scenario runner changes

Use production workflow paths for artifact scenarios.

Candidate scenario builders:

```ts
when.marketplace.pushStatic({ orgId: "org-1" });
when.marketplace.ingest({ orgId: "org-1", slug: "telegram-test-command" });
then.marketplace.ingested({
  orgId: "org-1",
  slug: "telegram-test-command",
  version: "1.0.0",
});
```

`given.marketplace.entries(...)` may remain useful for metadata-only tests, but download/ingestion
tests should publish artifacts through `marketplace-publish` and drain the owning organization
Automations workflow queue.

The scenario runner must discover and drain the relevant organization Automations workflow queues.
Project and user destinations do not introduce additional workflow owners.

## Failure and retry invariants

- A Marketplace version is not public before its files are written and its `artifactDirectory` is
  stored.
- A published version's `artifactDirectory` is immutable.
- Publication retries may rewrite the same version-directory paths before publication.
- Ingestion retries read the published directory from Marketplace and enumerate it again from
  Upload.
- An ingestion row's `version` always means the complete directory was copied and verified.
- Failed updates do not change the last successful ingestion version.
- The organization Automations object rejects destination scopes outside its authorization boundary.
- Marketplace owner authorization is checked before publication workflow creation.
- Existing workspace files are not overwritten when checksums differ.

## Explicit non-goals

Do not add these until a demonstrated use case requires them:

- `manifest.json` or any other Upload-side manifest file;
- a JSON manifest column or separate manifest table;
- per-file Marketplace database rows;
- per-file Automations ingestion rows;
- ZIP or tar package generation;
- public signed download URLs;
- installation receipt files;
- a global Marketplace installation registry;
- an `outdated` persistence column;
- automatic background scans of every workspace;
- arbitrary installation destination directories;
- force-overwrite behavior.

## Validation

For each vertical slice:

```sh
pnpm --dir apps/backoffice run types:check
pnpm --dir apps/backoffice test
pnpm --dir apps/backoffice run build
pnpm run lint:type-aware-fix
pnpm run format:changed
git diff --check
```

Final end-to-end scenarios must prove:

- publication workflow ownership belongs to the requesting organization Automations object;
- ingestion workflow ownership belongs to the requesting organization Automations object;
- Marketplace versions store only their artifact directory in addition to catalog state;
- Upload alone enumerates artifact files and metadata;
- organization/project/user destinations have isolated ingestion rows within the organization;
- a newly published version makes an older local ingestion appear out of date.
