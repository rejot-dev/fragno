# About sandboxes

> Status: outline · Documentation type: explanation

This document should explain how the Backoffice provisions isolated execution environments and
manages them through durable workflows.

## Planned sections

- Sandbox providers and runtime handles.
- Instance identity, scope ownership, and persisted status.
- Request, starting, running, stopping, stopped, and error states.
- Startup commands and timeouts.
- `keepAlive` and `sleepAfter` lifecycle controls.
- Command execution, files, directories, and bucket mounts.
- Stop requests, retry behavior, and terminal reconciliation.
- Sandbox lifecycle events and observability.

## Code references

- `apps/backoffice/app/sandbox/contracts.ts` — provider and runtime interfaces.
- `apps/backoffice/app/sandbox/cloudflare-sandbox-provider.ts` — Cloudflare implementation.
- `apps/backoffice/app/fragno/automation/sandboxes.ts` — public schemas and state types.
- `apps/backoffice/app/fragno/automation/sandboxes-storage-runtime.ts` — persisted instance
  services.
- `apps/backoffice/app/fragno/automation/sandbox-lifecycle-workflow.ts` — durable lifecycle.
- `apps/backoffice/app/fragno/automation/schema.ts` — `sandbox_instance` table.
- `apps/backoffice/workers/sandbox.do.ts` — sandbox Durable Object.
- `apps/backoffice/app/routes/backoffice/automations/sandboxes.tsx` — sandbox UI.
- `apps/backoffice/content/static/skills/sandbox/SKILL.md` — current usage guidance.
