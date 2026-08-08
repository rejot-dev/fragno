# Backoffice system documentation

> Status: outline

These documents describe how the Backoffice system is organized and how its major subsystems relate.
They are product-owned files and are available in the mounted filesystem under `/static/docs/`.

The initial documentation is primarily **explanation** and **reference**. Task-oriented how-to
guides and tutorials should be added separately when concrete user journeys are identified.

## System map

- [Automations](automations/README.md) — scripts, workflows, routes, triggers, and schedules.
- [Store](store.md) — scope-local key-value state used by automations.
- [Events](events/README.md) — the event envelope, ingestion, persistence, and routing.
- [Interfaces](interfaces/README.md) — API surfaces, integrations, and MCP servers.
- [Sandboxes](sandboxes.md) — isolated execution environments and their lifecycle.
- [File system](file-system.md) — mounted namespaces, ownership, permissions, and persistence.
- [Marketplace](marketplace.md) — listings, versions, artifacts, publishing, and installation.

## Architecture references

Start with these files when writing a broader system overview:

- `apps/backoffice/app/backoffice-runtime/context.ts`
- `apps/backoffice/app/backoffice-runtime/kernel.ts`
- `apps/backoffice/app/backoffice-runtime/object-registry.ts`
- `apps/backoffice/app/backoffice-runtime/runtime-services.ts`
- `apps/backoffice/app/worker-runtime/router-context.ts`
- `apps/backoffice/workers/app.ts`
- `apps/backoffice/app/routes.ts`
