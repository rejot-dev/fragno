# Backoffice Capabilities Consolidation Plan

This plan tracks the remaining work after the initial capability registry/runtime-tool foundation.

Current foundation already implemented:

- Central `backofficeCapabilities` registry.
- Registry-backed hook fragment discovery.
- `hooks.scopes.list`.
- `connections.list/get/setup/configure`.
- `events.catalog`.
- `hooks.list --fragment` validates against the registry.
- Durable-hook repository resolution goes through the registry.
- Runtime tools have been renamed to:
  - `identity.*`
  - `events.*`
- New bash tools default to formatted output unless `--format json` / `--print` is used.

## Goal

End state:

- One registry answers:
  - which connections exist
  - how they are configured
  - which runtime tools they expose
  - which hook scopes they own
  - which automation events they emit
  - how agents should guide setup
- Runtime tools, UI, codemode docs, and automation contracts derive from that registry where
  practical.
- No duplicated source/type/event/connection metadata scattered across unrelated files.

---

## [x] Phase 1 — Split the registry into a maintainable capability module

Current new file is useful but too large:

- `apps/backoffice/app/fragno/backoffice-capabilities.ts`

Refactor into:

```txt
apps/backoffice/app/fragno/backoffice-capabilities/
  types.ts
  registry.ts
  hook-scopes.ts
  automation-events.ts
  connections.ts
  capabilities/
    telegram.ts
    resend.ts
    reson8.ts
    upload.ts
    pi.ts
    otp.ts
    automations.ts
    github.ts
    cloudflare.ts
    auth.ts
```

Use the split module as the canonical import location. Do **not** add compatibility re-exports from
the old file. Update call sites to import directly from the canonical files, e.g.:

```ts
import { getHookScope } from "@/fragno/backoffice-capabilities/hook-scopes";
import { listConnectionCapabilities } from "@/fragno/backoffice-capabilities/connections";
import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/types";
```

Delete `apps/backoffice/app/fragno/backoffice-capabilities.ts` after all imports have moved.

### Why

Right now, `backoffice-capabilities.ts` mixes:

- registry types
- connection status adaptation
- hook repository access
- event descriptors
- DO access helpers
- setup guides

That will become hard to extend. Splitting lets each connection own its metadata.

### Files to update

- `apps/backoffice/app/fragno/backoffice-capabilities.ts`
- `apps/backoffice/app/fragno/automation/durable-hooks-route-runtime.ts`
- `apps/backoffice/app/fragno/runtime-tools/families/automations-durable-hooks.ts`
- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`

### Acceptance criteria

- `registry.ts` exports `backofficeCapabilities`.
- `hook-scopes.ts` exports `listHookScopes`, `getHookScope`.
- `connections.ts` exports `listConnectionCapabilities`, `getConnectionCapability`.
- `automation-events.ts` exports event catalog helpers.
- No compatibility re-export exists at `apps/backoffice/app/fragno/backoffice-capabilities.ts`.
- All call sites import directly from canonical split files.

---

## [x] Phase 2 — Add real connection config schemas

Current state:

- `connections.configure` accepts `payload: unknown`.
- Per-connection validation lives inside DO files:
  - `apps/backoffice/workers/telegram.do.ts`
  - `apps/backoffice/workers/resend.do.ts`
  - `apps/backoffice/workers/reson8.do.ts`
  - `apps/backoffice/workers/upload.do.ts`
  - `apps/backoffice/workers/pi.do.ts`

### Plan

Extract admin config schemas into shared modules under app code, not worker-only files.

Example:

```txt
apps/backoffice/app/fragno/connections/telegram-admin-config.ts
apps/backoffice/app/fragno/connections/resend-admin-config.ts
apps/backoffice/app/fragno/connections/reson8-admin-config.ts
apps/backoffice/app/fragno/connections/pi-admin-config.ts
apps/backoffice/app/fragno/connections/upload-admin-config.ts
```

Each exports:

```ts
export const telegramConfigureInputSchema = z.object(...);
export type TelegramConfigureInput = z.input<typeof telegramConfigureInputSchema>;

export const telegramConnectionPreviewSchema = z.object(...);
```

Then:

- DO uses the shared schema.
- Capability registry uses the shared schema.
- Runtime tool reference can expose it.
- `connections.setup --id telegram --format json` can return schema-derived field info.
- `connections.configure` can validate before calling the DO.

### Files to update

- `apps/backoffice/workers/telegram.do.ts`
- `apps/backoffice/workers/resend.do.ts`
- `apps/backoffice/workers/reson8.do.ts`
- `apps/backoffice/workers/upload.do.ts`
- `apps/backoffice/workers/pi.do.ts`
- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`
- new shared schema files under `apps/backoffice/app/fragno/connections/`

### Acceptance criteria

`connections.setup --id telegram --format json` returns something like:

```json
{
  "id": "telegram",
  "fields": [
    {
      "name": "botToken",
      "secret": true,
      "required": true,
      "description": "Telegram BotFather bot token"
    },
    {
      "name": "webhookSecretToken",
      "secret": true,
      "required": true
    }
  ]
}
```

`connections.configure` rejects invalid input before reaching the DO.

---

## [x] Phase 3 — Make setup guides structured, not just strings

Current state:

- `setupGuide` is an array of strings in the registry.

### Plan

Replace with structured setup instructions:

```ts
type ConnectionSetupGuide = {
  overview: string;
  manualSteps: {
    id: string;
    title: string;
    instructions: string;
    expectedUserInput?: string[];
  }[];
  configureFields: ConnectionConfigureField[];
  verify?: {
    tool: string;
    description: string;
  };
};
```

Example for Telegram:

```ts
setup: {
  overview: "Connect a Telegram bot to this organisation.",
  manualSteps: [
    {
      id: "create-bot",
      title: "Create a Telegram bot",
      instructions: "Open BotFather, run /newbot, and copy the bot token.",
      expectedUserInput: ["botToken"]
    },
    {
      id: "choose-secret",
      title: "Choose webhook secret",
      instructions: "Generate a long random webhook secret.",
      expectedUserInput: ["webhookSecretToken"]
    }
  ],
  verify: {
    tool: "connections.get --id telegram",
    description: "Check configured=true and webhook.ok=true."
  }
}
```

### Files to update

- `apps/backoffice/app/fragno/backoffice-capabilities/types.ts`
- `apps/backoffice/app/fragno/backoffice-capabilities/capabilities/telegram.ts`
- similar per-connection capability files
- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`

### Acceptance criteria

- `connections.setup --id telegram` human output is readable.
- `connections.setup --id telegram --format json` is structured enough for an agent to drive a setup
  session.

---

## [x] Phase 4 — Add explicit connection verification and lifecycle tools

Current state:

- `connections.configure` sometimes returns webhook verification info.
- There is no standard verify/reset/rotate story.

### Add runtime tools

```bash
connections.verify --id telegram
connections.reset --id telegram
connections.schema --id telegram
```

Possibly later:

```bash
connections.rotate-secret --id telegram --field webhookSecretToken
```

### Registry shape

```ts
connection: {
  configureSchema,
  getStatus,
  configure,
  verify?,
  reset?,
}
```

### Files to update

- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`
- each relevant capability file
- DOs need reset methods:
  - `apps/backoffice/workers/telegram.do.ts`
  - `apps/backoffice/workers/resend.do.ts`
  - `apps/backoffice/workers/reson8.do.ts`
  - `apps/backoffice/workers/upload.do.ts`
  - `apps/backoffice/workers/pi.do.ts`

### Acceptance criteria

- `connections.verify --id telegram` does not mutate config unless intentionally documented.
- `connections.reset --id reson8` clears stored config and runtime.
- Reset requires explicit confirmation argument, e.g.:

```bash
connections.reset --id reson8 --confirm reson8
```

---

## [x] Phase 5 — Centralize automation event schemas

Current state:

- `apps/backoffice/app/fragno/automation/contracts.ts` still defines:
  - `AUTOMATION_SOURCES`
  - `AUTOMATION_SOURCE_EVENT_TYPES`
  - known event type aliases
- Registry has event descriptors but not real payload schemas.
- Event builders live in:
  - `apps/backoffice/app/fragno/telegram.ts`
  - `apps/backoffice/app/fragno/otp.ts`

### Plan

Add schema-bearing event descriptors:

```ts
type AutomationEventDescriptor = {
  source: string;
  eventType: string;
  label: string;
  payloadSchema: z.ZodType;
  actorSchema?: z.ZodType;
  subjectSchema?: z.ZodType;
  example?: unknown;
};
```

In capability files:

```ts
// backoffice-capabilities/capabilities/telegram.ts
export const telegramMessageReceivedEvent = defineAutomationEvent({
  source: "telegram",
  eventType: "message.received",
  payloadSchema: telegramMessagePayloadSchema,
  ...
});
```

Then update:

- `apps/backoffice/app/fragno/telegram.ts`
- `apps/backoffice/app/fragno/otp.ts`

so event builders use descriptors or import source/type constants from descriptor modules.

### What to do with `automation/contracts.ts`

Keep it, but convert it into derived compatibility exports:

```ts
export const AUTOMATION_SOURCES = deriveAutomationSources(backofficeCapabilities);
export const AUTOMATION_SOURCE_EVENT_TYPES =
  deriveAutomationSourceEventTypes(backofficeCapabilities);
```

Eventually remove those constants if no longer needed.

### Files to update

- `apps/backoffice/app/fragno/automation/contracts.ts`
- `apps/backoffice/app/fragno/telegram.ts`
- `apps/backoffice/app/fragno/otp.ts`
- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`
- automation tests:
  - `apps/backoffice/app/fragno/telegram.test.ts`
  - `apps/backoffice/app/fragno/otp.test.ts`
  - `apps/backoffice/app/fragno/automation/*.test.ts`

### Acceptance criteria

`events.catalog --format json` returns schemas or schema summaries, not just labels:

```json
{
  "source": "telegram",
  "eventType": "message.received",
  "payloadSchema": { "type": "object", "properties": {} }
}
```

---

## [x] Phase 6 — Use event catalog in automation binding UI/tools

Current automation binding routes accept arbitrary strings:

- `apps/backoffice/app/fragno/automation/routes.ts`
- `apps/backoffice/app/fragno/automation/definition.ts`
- automation file content/templates:
  - `apps/backoffice/app/files/content/automations.ts`

### Plan

Do not forbid custom events immediately, but distinguish:

```ts
type AutomationEventBindingTarget =
  | { kind: "known"; source: string; eventType: string }
  | { kind: "custom"; source: string; eventType: string };
```

Use registry to:

- autocomplete known sources/event types
- validate known event payloads in dev/test tools
- document event shapes in codemode prompt

### Files to update

- `apps/backoffice/app/fragno/automation/routes.ts`
- `apps/backoffice/app/fragno/automation/catalog.ts`
- `apps/backoffice/app/files/content/automations.ts`
- docs/system prompt generation:
  - `apps/backoffice/app/fragno/runtime-tools/reference.ts`
  - `apps/backoffice/app/routes/dev/codemode-agents.ts`
  - `apps/backoffice/app/files/content/system.ts`

### Acceptance criteria

Agents can ask:

```bash
events.catalog
```

then confidently create an automation binding for a known event.

---

## [x] Phase 7 — Runtime tool families should be capability-aware

Current state:

- `apps/backoffice/app/fragno/runtime-tools/tool-families.ts` manually lists all tool families.
- Registry only stores `runtimeToolNamespaces`, not actual family ownership.

### Plan

Add capability metadata to tool definitions:

```ts
type BackofficeRuntimeTool = {
  ...
  capabilityId?: BackofficeCapabilityId;
};
```

Then each family/tool declares ownership:

```ts
defineBackofficeRuntimeTool({
  id: "telegram.chat.send",
  namespace: "telegram",
  capabilityId: "telegram",
  ...
});
```

For generic families:

- `identity.*` → `capabilityId: "automations"`
- `events.*` → `capabilityId: "automations"`
- `hooks.*` → probably `capabilityId: "automations"` or `"system"`
- `workflow.*` → `capabilityId: "automations"`
- `connections.*` / `fragments.*` → `capabilityId: "system"` or no capability

Then derive command grouping from actual tool metadata, not manually maintained
`runtimeToolNamespaces`.

### Files to update

- `apps/backoffice/app/fragno/runtime-tools/runtime-tools.ts`
- all files in `apps/backoffice/app/fragno/runtime-tools/families/*.ts`
- `apps/backoffice/app/fragno/runtime-tools/tool-families.ts`
- `apps/backoffice/app/fragno/backoffice-capabilities/*`

### Avoid import cycles

Do **not** make base capability descriptors import runtime tool families directly.

Better:

- capability registry = pure domain metadata
- runtime tool registry = imports capabilities and tools, then links by `capabilityId`

Example:

```txt
backoffice-capabilities/registry.ts       # no runtime tool imports
runtime-tools/tool-families.ts            # imports runtime tools and capability IDs
runtime-tools/capability-tools.ts         # computes mapping
```

### Acceptance criteria

`connections.list --format json` reports runtime tools by looking at registered tools, not static
duplicated namespace strings.

---

## [x] Phase 8 — Model availability/configured/healthy separately

Current state:

- `hooks.scopes.list` lists hook scopes, not whether configured.
- `connections.list` checks configurable connections only.
- Some system capabilities are always available; others depend on env bindings or org config.

### Plan

Introduce status dimensions:

```ts
type CapabilityStatus = {
  id: string;
  available: boolean; // binding/code exists
  configured: boolean; // user/env config present
  healthy?: boolean; // optional verification
  reason?: string;
};
```

Then add:

```bash
capabilities.list
hooks.scopes.list --include-status
connections.list
```

Maybe keep `hooks.scopes.list` focused on hook scopes, but include:

```json
{
  "id": "telegram",
  "configured": true,
  "hooksEnabled": true
}
```

### Files to update

- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts`
- `apps/backoffice/app/fragno/backoffice-capabilities/types.ts`
- per-capability status implementations

### Acceptance criteria

`hooks.scopes.list` tells the user whether `hooks.list --fragment telegram` is expected to work.

---

## [x] Phase 9 — Add GitHub and Cloudflare connection semantics properly

Current state:

- GitHub and Cloudflare are in the registry mainly for hooks.
- GitHub config is environment/app-based:
  - `apps/backoffice/workers/github.do.ts`
  - `apps/backoffice/workers/github.shared.ts`
  - `apps/backoffice/workers/github-webhook-router.do.ts`
- Cloudflare worker/platform config likely depends on env bindings and external account setup.

### Plan

Add a `configurationScope` field:

```ts
type ConnectionConfigurationScope = "organization" | "environment" | "singleton" | "external";
```

For GitHub:

- `configured` should reflect env/app config and webhook router setup.
- `connections.get --id github` should explain if config is environment-managed.
- `connections.setup --id github` should point to GitHub App setup flow.
- `connections.configure --id github` may be unsupported or only support org-level install mapping
  if that exists.

For Cloudflare:

- expose status and setup instructions.
- if no runtime configure is possible, make that explicit:

```json
{
  "configurable": false,
  "configurationScope": "environment",
  "nextSteps": ["Set CLOUDFLARE_* environment bindings/secrets."]
}
```

### Files to inspect/update

- `apps/backoffice/workers/github.do.ts`
- `apps/backoffice/workers/github.shared.ts`
- `apps/backoffice/workers/github-webhook-router.do.ts`
- `apps/backoffice/workers/cloudflare-wfp.do.ts`
- GitHub routes:
  - `apps/backoffice/app/routes/backoffice/connections/github/*`
- Cloudflare/runtime tools if any:
  - search under `apps/backoffice/app/fragno/runtime-tools/families/`

### Acceptance criteria

`connections.list` includes GitHub and Cloudflare with honest config state, even if not
runtime-configurable.

---

## [x] Phase 10 — Integrate registry with the Backoffice UI

Current UI is per-connection and direct-to-DO:

- `apps/backoffice/app/routes/backoffice/connections/index.tsx`
- `apps/backoffice/app/routes/backoffice/connections/telegram/*`
- `apps/backoffice/app/routes/backoffice/connections/resend/*`
- `apps/backoffice/app/routes/backoffice/connections/reson8/*`
- `apps/backoffice/app/routes/backoffice/connections/upload/*`
- `apps/backoffice/app/routes/backoffice/connections/github/*`

### Plan

Start small:

1. Make `/backoffice/connections` list derive cards from `backofficeCapabilities`.
2. Use registry labels/status/setup text.
3. Keep specialized pages for rich connection-specific UI.

Then later:

- generic config form generated from `configureSchema`
- generic status panel
- generic setup guide panel

### Files to update

- `apps/backoffice/app/routes/backoffice/connections/index.tsx`
- per-connection `data.ts` files:
  - `telegram/data.ts`
  - `resend/data.ts`
  - `reson8/data.ts`
  - `upload/data.ts`
  - `github/data.ts`
- shared UI components if present under:
  - `apps/backoffice/app/routes/backoffice/connections/*/shared.tsx`

### Acceptance criteria

Adding a new connection to the capability registry automatically shows it in the main connections
page.

---

## [x] Phase 11 — Update generated docs / codemode prompt

Current prompt/reference generation is mostly runtime-tool based:

- `apps/backoffice/app/fragno/runtime-tools/reference.ts`
- `apps/backoffice/app/routes/dev/codemode-agents.ts`
- `apps/backoffice/app/files/content/system.ts`
- `apps/backoffice/app/fragno/pi/pi-shared.ts`

### Plan

Add a “Discovery first” section:

```md
Start with:

- hooks.scopes.list
- connections.list
- events.catalog
```

Add connection setup guidance:

```md
To configure a connection:

1. connections.setup --id <id>
2. collect required values from user
3. connections.configure --id <id> --json ...
4. connections.verify --id <id>
```

### Acceptance criteria

The generated codemode AGENTS/system prompt explains the new model and no longer references obsolete
`automations.*` tools.

---

## [x] Phase 12 — Tests and migration cleanup

### Test files to update/expand

Existing affected tests:

- `apps/backoffice/app/fragno/runtime-tools/families/automations.test.ts`
- `apps/backoffice/app/fragno/runtime-tools/bash-commands.test.ts`
- `apps/backoffice/app/fragno/runtime-tools/reference.test.ts`
- `apps/backoffice/app/fragno/runtime-tools/automation-host.test.ts`
- `apps/backoffice/app/fragno/codemode/run-backoffice-codemode.cloudflare.test.ts`
- `apps/backoffice/app/fragno/automation/engine/codemode.cloudflare.test.ts`
- `apps/backoffice/app/fragno/pi/exec-code-mode.cloudflare.test.ts`
- `apps/backoffice/app/files/content/automations.test.ts`

Add new tests:

```txt
apps/backoffice/app/fragno/backoffice-capabilities/registry.test.ts
apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.test.ts
```

Test:

- every hook scope resolves a repository
- every connection has setup info
- every configurable connection has a schema
- every automation event descriptor has a schema/example
- `connections.list` has table output by default and JSON with `--format json`
- no obsolete command names appear in generated docs

### Also clean stale docs

Current changed file:

- `apps/backoffice/CODEMODE_AUTOMATION_RUNTIME_PLAN.md`

Either update it fully or move old content into an archive note so it does not describe obsolete
`automations.*` APIs.

---

## Recommended order

1. Registry split — prevents the current file from becoming unmaintainable.
2. Config schemas — unlocks serious agent-driven setup.
3. Structured setup guides — makes setup useful to agents.
4. Event schemas — makes automation catalog real.
5. Capability-aware runtime tools — removes duplicated namespace metadata.
6. Status model — improves discovery/diagnostics.
7. GitHub/Cloudflare status — complete connection list.
8. UI integration — use the registry in product surfaces.
9. Lifecycle tools — reset/verify/rotate.
10. Docs/tests cleanup — lock it all down.

That sequence keeps each step shippable and avoids turning the registry into another parallel
abstraction before it has enough real data to replace the old scattered sources.
