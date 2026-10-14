---
name: admin
description: >
  Administer Backoffice. Use for admin.* tools, Marketplace curation, System-only publication
  overrides, or bundled Marketplace seeding.
---

# Backoffice Administration

Read `/static/codemode/providers/admin.d.ts` before authoring admin calls. It defines the available
invitation, organization, app, OAuth client, and Marketplace administration operations.

For Marketplace operations, also read `/static/codemode/providers/marketplace.d.ts`.

## Featuring listings

Featured listings lead each Marketplace: the public `/marketplace` page shows only them, and
signed-in catalogs open on them. The execution scope decides which Marketplace is curated:

- System scope curates the public Marketplace and requires a System administrator.
- Organization scope curates that organization's Marketplace and requires an organization owner or
  admin.

The shell command `admin.marketplace.feature` features a published listing. `--starts-at` schedules
the feature, `--until` ends it, higher `--priority` shows first, and `--note` adds a curator note.
Featuring an already featured listing replaces those settings. `admin.marketplace.unfeature` removes
an entry, and `marketplace.featured` lists every entry as active, scheduled, expired, or hidden (no
longer published). A Marketplace holds at most 24 entries; featuring removes expired and hidden
entries to make room. In JavaScript, use `admin.marketplaceFeature`, `admin.marketplaceUnfeature`,
and `marketplace.featured`.

Confirm the intended settings or removal with `marketplace.featured`. System administrators browse
the public Marketplace they curate at `/backoffice/marketplace/system/system/marketplace`.

## Publication overrides

For manifest preparation, visibility, and dry-run validation, read
`/static/skills/marketplace-publishing/SKILL.md`.

`marketplace.publish` accepts `skipAuthorCheck` / `--skip-author-check` and `skipVersionCheck` /
`--skip-version-check` only in System context. Use these overrides for authorized backfills and
version replacements.

Inspect the coordinating System workflow for execution failures. For a replacement, confirm that
workflow completed: the preexisting version in `marketplace.view` is not proof that its snapshot was
replaced. Until then, report acceptance and the workflow reference rather than completed
publication.

## Bundled seeding and replacement lifecycle

Use `admin.marketplacePushStatic` to publish bundled static Marketplace entries from System context.
Bundled seeding skips published versions unless forced, submits backfills through the System version
override, and never regresses the latest version. Its shared listing-root documents are initialized
separately; they are not part of release replacement.

Workspace manifests and bundled System entries are capture adapters for the same release publisher.
Both freeze ownership, metadata, and file bytes before enqueueing `marketplace-package-publish`.
Replacements atomically write the complete file set and remove omitted files, then update the
catalog in a separate commit. The fingerprint covers metadata as well as files, and superseded
workflow restarts conflict instead of restoring older contents.
