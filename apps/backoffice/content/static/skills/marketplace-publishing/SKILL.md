---
name: marketplace-publishing
description: >
  Publish workspace packages to Marketplace. Use when creating package manifests, validating a
  release with a dry run, requesting publication, or performing System-only backfills and version
  replacements.
---

# Marketplace Publishing

Read `/static/codemode/providers/marketplace.d.ts` before authoring publishing calls.

A package root contains one release described by `manifest.json`. Publish from the current readable
filesystem; the manifest resolves ownership independently of the source workspace.

## 1. Prepare the release

Use the owning organization's current slug in the scoped package name. Organization membership is
required even when the files live in your personal or another authorized workspace. The resolved
organization ID, rather than its slug, owns the listing; the publisher display name comes from that
organization. Publishing actor provenance is recorded separately.

```json
{
  "name": "@ada-labs/daily-report",
  "version": "1.0.0",
  "metadata": {
    "name": "Daily report",
    "summary": "Generate a daily operations report.",
    "description": "A saved workflow for generating an operations report.",
    "category": "reporting",
    "tags": ["report", "workflow"]
  },
  "files": ["README.md", "automations/", ".marketplace/install.workflow.js"]
}
```

`files` is an explicit allowlist of relative POSIX file or directory paths, not globs. Directories
include descendants. Keep selections disjoint; `manifest.json` is included automatically. Include
`.marketplace/install.workflow.js` only when the package has an installer. Publishing validates and
captures bytes without executing workflows, installers, or package scripts.

Known secret paths, dependency directories, Git metadata, traversal, and links cannot be published.
The captured release is limited to 100 files including the manifest and 1 MiB of total file content.
Binary files are supported. Remove concurrent source edits if capture reports that the package
changed. The publisher reserves `.marketplace/publish.json` for its atomic version guard; keep that
path out of authored packages. Publisher guard files are not installed into workspaces.

## 2. Validate the release

A dry run resolves the organization and checks authority, version rules, paths, checksums, and sizes
without staging bytes or starting a workflow:

```js
await marketplace.publish({ packageRoot: "/workspace/packages/daily-report", dryRun: true });
```

Inspect the preview's resolved owner, listing, version, and complete file inventory before
requesting publication. Resolve validation errors and rerun the dry run until that inventory matches
the intended release.

## 3. Request publication

A real request freezes the exact selected bytes and original publisher provenance in the input of a
durable System-coordinated publishing workflow:

```js
await marketplace.publish({ packageRoot: "/workspace/packages/daily-report" });
```

The shell equivalents are `marketplace.publish --package-root /workspace/packages/daily-report` and
the same command with `--dry-run`.

A `requested` result is acceptance, not completion. Retain its workflow instance ID and System
workflow scope. Use `marketplace.view` to confirm the release is publicly available; System
operators can inspect the coordinating workflow for execution failures. A `published` result means
the identical snapshot was already published. Repeating an identical pending request reuses the
current publishing workflow. Editing source files after acceptance does not alter the pending
release.

**Report completion** when the tool returns `published`, or `marketplace.view` confirms a newly
requested version is publicly available. For a System replacement, confirm the coordinating workflow
completed: the preexisting version in `marketplace.view` is not proof that its snapshot was
replaced. Otherwise report acceptance and the workflow reference rather than completed publication.

## Shared publishing lifecycle

Workspace manifests and bundled System entries are capture adapters for the same release publisher.
Both freeze ownership, metadata, and file bytes before enqueueing `marketplace-package-publish`.
Replacements atomically write the complete file set and remove omitted files, then update the
catalog in a separate commit. The fingerprint covers metadata as well as files, and superseded
workflow restarts conflict instead of restoring older contents.

Bundled seeding skips published versions unless forced, submits backfills through the System version
override, and never regresses the latest version. Its shared listing-root documents are initialized
separately; they are not part of release replacement.

## Version rules and System overrides

`skipAuthorCheck` / `--skip-author-check` and `skipVersionCheck` / `--skip-version-check` are
available only to admin users. Regular users who need a package replaced should contact ReJot
Backoffice support.
