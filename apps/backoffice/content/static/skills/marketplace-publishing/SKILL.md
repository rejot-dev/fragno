---
name: marketplace-publishing
description: >
  Publish workspace packages to Marketplace. Use when creating package manifests, declaring a
  package's routes, permissions, settings, or agents, validating a release with a dry run, or
  requesting publication.
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
  "files": ["README.md", "automations/", ".marketplace/"]
}
```

`files` is an explicit allowlist of relative POSIX file or directory paths, not globs. Directories
include descendants. Keep selections disjoint; `manifest.json` is included automatically. Publishing
validates and captures bytes without executing workflows, installers, or package scripts.

## Declare what an installation sets up

`.marketplace/installation.json` declares the permissions the package uses, and the routes and event
definitions Backoffice keeps in sync for each installation:

```json
{
  "permissions": [{ "namespace": "integrations", "permission": "execute" }],
  "routes": [
    {
      "id": "daily-report",
      "name": "Daily report",
      "trigger": {
        "kind": "schedule",
        "cadence": { "kind": "cron", "expression": "0 8 * * *", "timeZone": "UTC" }
      },
      "action": {
        "kind": "start_workflow",
        "authority": {
          "kind": "organization-automation",
          "grants": [{ "namespace": "integrations", "permission": "execute" }]
        },
        "workflowScriptPath": "automations/daily-report.workflow.js",
        "instanceIdTemplate": "daily-report-${event.id}"
      }
    }
  ],
  "eventDefinitions": [
    {
      "source": "reports",
      "eventType": "report.sent",
      "label": "Report sent",
      "payloadSchema": {
        "type": "object",
        "properties": { "reportId": { "type": "string" } },
        "required": ["reportId"]
      }
    }
  ]
}
```

- Routes use the `router.create` input. A `start_workflow` path names a file in the package;
  installation points it at the installed copy.
- A route's grants must be declared permissions. The installer approves exactly the declared
  permissions, and must hold each of them.
- Event definitions use the `events.catalog.create` input, and can't redefine built-in events.
- Installing creates or updates the declared routes and event definitions, and deletes those an
  earlier version declared. Members can turn them on or off but not change them. Uninstalling
  deletes them.
- Installing takes over an existing route or event definition only when the declaration leaves it
  unchanged, such as one an earlier version's install workflow created; any other is refused.
- A workspace holds one installation per package, so route ids stay fixed.

## Ask for settings

`.marketplace/install.workflow.js` is optional. It runs with the approved permissions plus
`packages.read`, but never `router.modify`: routes come only from the declaration. Declare event
definitions too, rather than creating them here, so installations keep them in sync. Whatever it
returns becomes the installation's settings, and the package's workflows read them with
`packages.get({ listingId })`. The install workflow reads the current installation the same way; it
is null on a first installation, and the record changes only after the workflow completes.
Installing the same version again re-runs it, which is how settings change. Use generated UI and
`step.waitForEvent` to ask the installer; only members who may install packages can answer.

## Define an agent

Agents aren't declared yet, so the install workflow defines them. It runs again on every install of
the same version, so create the agent when missing and update it when this package made it:

```js
const agent = {
  agentName: "triage",
  description: "Reviews workflow failures.",
  model: null,
  permissions: ["*"],
  instructions: "Investigate the failure you are given before changing anything.",
  managedBy: {
    kind: "marketplace",
    listingId: event.payload.listingId,
    resourceKey: "triage-agent",
    version: event.payload.version,
  },
};
await step.do("ensure triage agent", async () => {
  const { agents } = await pi.listAgents({});
  const existing = agents.find((candidate) => candidate.agentName === agent.agentName);
  if (!existing) {
    return await pi.createAgent(agent);
  }
  const owner = existing.managedBy;
  if (
    owner?.kind !== "marketplace" ||
    owner.listingId !== agent.managedBy.listingId ||
    owner.resourceKey !== agent.managedBy.resourceKey
  ) {
    throw new Error(`Agent '${agent.agentName}' already exists and belongs to someone else.`);
  }
  return await pi.updateAgent(agent);
});
```

Declare `pi.read`, to list agents, and `pi.manage`, to define them. Uninstalling leaves the agent;
delete it with `pi.deleteAgent` if it should go.

Known secret paths, dependency directories, Git metadata, traversal, and links cannot be published.
The captured release is limited to 100 files including the manifest and 1 MiB of total file content.
Binary files are supported. Remove concurrent source edits if capture reports that the package
changed. The publisher reserves `.marketplace/publish.json` for its atomic version guard; keep that
path out of authored packages. Publisher guard files are not installed into workspaces.

## 2. Choose visibility

Every publication states its `visibility`:

- `public` publishes to the public Marketplace, which every Backoffice user can browse and install
  from.
- `organization` publishes to the owning organization's Marketplace, which only that organization's
  members can browse and install from.

The two Marketplaces are separate catalogs. The same package name can be published to both; each
listing has its own versions. Ask which visibility is intended when the request does not say.

## 3. Validate the release

A dry run resolves the organization and checks authority, version rules, paths, checksums, and sizes
without staging bytes or starting a workflow:

```js
await marketplace.publish({
  packageRoot: "/workspace/packages/daily-report",
  visibility: "organization",
  dryRun: true,
});
```

Inspect the preview's resolved owner, listing, version, and complete file inventory before
requesting publication. Resolve validation errors and rerun the dry run until that inventory matches
the intended release.

## 4. Request publication

A real request freezes the exact selected bytes and original publisher provenance in the input of a
durable System-coordinated publishing workflow:

```js
await marketplace.publish({
  packageRoot: "/workspace/packages/daily-report",
  visibility: "organization",
});
```

The shell equivalents are
`marketplace.publish --package-root /workspace/packages/daily-report --visibility organization` and
the same command with `--dry-run`.

A `requested` result is acceptance, not completion. Retain its workflow instance ID and System
workflow scope. Use `marketplace.view` with the same `visibility` to confirm the release is
available; organization visibility reads the current workspace's organization Marketplace. A
`published` result means the identical snapshot was already published. Repeating an identical
pending request reuses the current publishing workflow. Editing source files after acceptance does
not alter the pending release.

**Report completion** when the tool returns `published`, or `marketplace.view` confirms a newly
requested version is available. When the current workspace belongs to another organization than the
package owner, report an accepted organization release with its workflow reference. Otherwise report
acceptance and the workflow reference rather than completed publication.

## Version rules

Published versions are immutable. Users who need a package replaced should contact ReJot Backoffice
support.
