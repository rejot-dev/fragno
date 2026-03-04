# Pi Backoffice Sessions — Spec

## Open Questions

None.

## 1. Overview

Integrate the `@fragno-dev/pi-fragment` into the backoffice so users can create and inspect agent
sessions per organization. The UI mirrors the Telegram integration patterns: org-scoped sessions,
list + detail layout, tabs, and Cloudflare Durable Object hosting. Users can create sessions by
choosing an **agent harness** (a named toolset + prompt defaults) and selecting a **model/provider**
from a dropdown. Manual message sending is **not** supported in v1; sessions are read-only after
creation except for refresh.

Key constraints:

- Sessions are scoped per org (same approach as Telegram integration).
- Workflows fragment is internal (no public `/api/workflows`).
- Harness selection is required when creating a session.
- Session detail view resembles Telegram chat detail UI, with Base UI toggles for tool call and
  trace visibility.
- Tool registry includes a `bash` tool backed by just-bash with an in-memory virtual filesystem.
- Model dropdown only shows newest models per provider.

## 2. References

- Telegram backoffice patterns: `apps/docs/app/routes/backoffice/connections/telegram/*`
- Telegram DO wiring: `apps/docs/workers/telegram.do.ts`
- API proxying: `apps/docs/app/routes/api/telegram.ts`
- DO helpers: `apps/docs/app/cloudflare/cloudflare-utils.ts`
- Backoffice navigation: `apps/docs/app/components/backoffice/sidebar.tsx`
- Pi fragment API + schemas: `packages/pi-fragment/src/routes.ts`,
  `packages/pi-fragment/src/pi/route-schemas.ts`
- Pi fragment client hooks: `packages/pi-fragment/src/pi/clients.ts`
- just-bash reference: `specs/references/just-bash.md`
- Pi DO reference implementation: `specs/references/pi-fragment-do.ts`
- OpenAI models reference: `specs/references/openai-models.md`
- Anthropic models reference: `specs/references/anthropic-models.md`
- Gemini models reference: `specs/references/gemini-models.md`

## 3. Terminology

- **Session**: A Pi agent workflow instance stored by the Pi fragment. Backed by the pi schema and
  workflow history.
- **Harness**: A named, org-configurable set of tools + agent defaults used to construct a Pi agent.
  In v1, each harness maps to **many** agent definitions (one per model/provider).
- **Model catalog**: The static, code-defined list of provider + model choices exposed in the UI.
- **Tool registry**: The static code-defined set of tool implementations available to harnesses.
- **VFS**: In-memory virtual filesystem used by the bash tool for sandboxed command execution.
- **Trace**: Agent execution events returned in `GET /sessions/:sessionId`.
- **Tool call**: A content block with `type: "toolCall"` inside assistant content or tool result
  messages.

## 4. Goals / Non-goals

### Goals

1. Org-scoped Pi sessions (create/list/detail) backed by a dedicated Durable Object per org.
2. Backoffice UI with tabs: **Sessions**, **Harnesses**, **Configuration**.
3. Session list + detail layout mirroring Telegram (list on left, detail on right, responsive
   collapse on mobile).
4. Session creation with harness + model/provider, plus full session fields (name, steering mode,
   tags, metadata).
5. Session detail rendering of user/assistant/tool result messages with toggles for tool calls,
   thinking blocks, trace, and usage.
6. Manual refresh control to reload session state.
7. Bash tool integration using just-bash + in-memory VFS.

### Non-goals (v1)

- Manual message sending to a session (no `POST /sessions/:id/messages` from UI).
- Streaming/auto-refresh. Manual refresh only.
- Exposing the Workflows HTTP API publicly.
- Harness CRUD (Harnesses tab is read-only).

## 5. Architecture & Responsibilities

### 5.1 Cloudflare Durable Object (per org)

Add a new Durable Object class `Pi` bound as `PI`. Each org uses `env.PI.idFromName(orgId)` to
ensure isolation, matching the Telegram pattern.

Responsibilities:

- Load per-org Pi config (API keys, harnesses) from DO storage.
- Build Pi runtime: create Pi agents per harness + model catalog, static tool registry, and
  workflows registry.
- Instantiate Workflows fragment internally with the Pi workflows registry.
- Instantiate Pi fragment and pass the Workflows fragment services.
- Run `migrate()` for both fragments and a durable hooks dispatcher (Cloudflare DO alarms) for both
  fragments.
- Expose admin methods for config retrieval and updates (invoked directly from loaders/actions).
- Route standard fragment HTTP requests via `fragment.handler(request)`.

### 5.1.1 Durable Object shape (reference)

Use the DO skeleton from `specs/references/pi-fragment-do.ts` as a template for the Pi DO shape. Key
elements to preserve in the backoffice implementation:

- Class-level fields for the fragment instance, hooks dispatcher, and `initPromise`.
- `blockConcurrencyWhile` for adapter setup, fragment instantiation, and migrations.
- Durable hooks dispatcher constructed via `createDurableHooksProcessor` and bound to `alarm()`.
- `fetch()` waits for `initPromise` and forwards to `fragment.handler()` with safe body cloning.

Minimal shape (illustrative):

```ts
export class Pi extends DurableObject<CloudflareEnv> {
  #fragment: PiFragment | null = null;
  #dispatcher: DurableHooksDispatcher | null = null;
  #initPromise: Promise<void>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#initPromise = state.blockConcurrencyWhile(async () => {
      // build adapter
      // build workflows fragment + pi fragment
      // migrate both
      // create durable hooks dispatcher
    });
  }

  async fetch(request: Request) {
    await this.#initPromise;
    return this.#fragment!.handler(request);
  }

  async alarm() {
    await this.#initPromise;
    await this.#dispatcher?.alarm?.();
  }
}
```

### 5.2 Pi runtime assembly

Create a backoffice module (e.g., `apps/docs/app/fragno/pi.ts`) to build the runtime:

- Static tool registry lives in code (tool IDs + handler implementations).
- Tool registry includes `bash` (from `bash-tool`) backed by `just-bash` and an in-memory VFS.
- Harnesses are read-only, loaded from DO config, and contain system prompt + tools + optional
  defaults (thinking level, steering mode, tool config).
- Model catalog is static in code; UI uses it to populate provider/model dropdowns.
- Agents are generated as the Cartesian product of harnesses × model catalog.
  - Agent name format: `${harnessId}::${provider}::${model}`.
  - Session creation uses this agent name in `POST /sessions`.
- `model` resolved via `@mariozechner/pi-ai` `getModel(provider, modelName)`.
- `getApiKey` (if needed) closes over the per-org API key config stored in DO storage.
- Bash tool uses a per-session in-memory filesystem. Store a `Map<sessionId, InMemoryFs>` inside the
  DO instance and reuse it across turns. Filesystem is ephemeral (resets on DO eviction).

### 5.3 Workflows fragment (internal)

Instantiate Workflows fragment with the Pi workflows registry (`createPi().build().workflows`). Do
**not** mount the Workflows routes publicly; the instance exists solely to provide `services` for Pi
fragment routes and workflow execution.

### 5.4 Backoffice UI

- Add a “Sessions” link in the main backoffice sidebar, pointing to the active org’s sessions.
- Route layout and tabs mirror Telegram (org layout + tabs + nested routes).
- Sessions list and detail view reuse the list/detail structure from Telegram’s Messages view.

## 6. Data Model & Storage

### 6.1 Pi fragment schema

Use the Pi fragment schema as-is (session table, workflow instance linkage). No new DB schema is
introduced in the app layer. See `packages/pi-fragment/src/schema.ts` for table details.

### 6.2 Org config storage (DO storage)

Store org configuration in DO storage under a single key (`pi-config`):

```ts
type PiModelProvider = "openai" | "anthropic" | "gemini";

type StoredPiConfig = {
  apiKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
  harnesses: PiHarnessConfig[];
  createdAt: string;
  updatedAt: string;
};

type PiHarnessConfig = {
  id: string; // used in agent name
  label: string;
  description?: string;
  systemPrompt: string;
  tools: string[]; // tool IDs from static registry
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  steeringMode?: "all" | "one-at-a-time";
  toolConfig?: unknown; // optional per-harness tool config
};
```

Model catalog lives in code (not in DO storage) and includes only newest models per provider:

```ts
type PiModelOption = {
  provider: PiModelProvider;
  name: string; // model id
  label?: string; // UI label
};

export const PI_MODEL_CATALOG: PiModelOption[] = [
  { provider: "openai", name: "gpt-5.2", label: "GPT-5.2" },
  { provider: "openai", name: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
  { provider: "openai", name: "gpt-5-mini", label: "GPT-5 mini" },
  { provider: "openai", name: "gpt-5-nano", label: "GPT-5 nano" },
  { provider: "anthropic", name: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", name: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "anthropic", name: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { provider: "gemini", name: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  { provider: "gemini", name: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
];
```

## 7. HTTP API & Admin Methods

### 7.1 Public fragment routes (via proxy)

Mount the Pi fragment at `/api/pi` inside the DO and proxy requests from the app route:

- `POST /api/pi/:orgId/sessions`
- `GET /api/pi/:orgId/sessions`
- `GET /api/pi/:orgId/sessions/:sessionId`
- `POST /api/pi/:orgId/sessions/:sessionId/messages` (not used by UI in v1)

Implementation mirrors `apps/docs/app/routes/api/telegram.ts`.

### 7.2 Admin methods (DO direct calls)

Expose internal methods on the DO class (invoked via the DO stub in loaders/actions):

- `getAdminConfig(): { configured: boolean; config?: StoredPiConfig }`
- `setAdminConfig(payload): { configured: boolean; config: StoredPiConfig }`

`configured` is `true` if required API keys and at least one harness exist.

## 8. Backoffice Routing & UI

### 8.1 Route structure (mirrors Telegram)

Add routes in `apps/docs/app/routes.ts`:

- `/backoffice/sessions` (redirect to active org)
- `/backoffice/sessions/:orgId` (org layout)
  - `index` (overview, optional redirect to `/sessions`)
  - `/sessions` (list + detail layout)
    - `index` (empty state)
    - `/:sessionId` (detail)
  - `/harnesses`
  - `/configuration`

### 8.2 Tabs

Tabs shown in the org layout:

- **Sessions** — list + detail view.
- **Harnesses** — read-only harness list + details.
- **Configuration** — API key form + status (configured/unconfigured).

### 8.3 Sessions list + detail

List view shows:

- Session name (fallback to session id)
- Harness label (resolve via harness id in agent name)
- Model/provider (resolve via agent name)
- Status chip
- Updated timestamp
- Last summary snippet (from `summaries`)

Detail view renders messages in a scroll area, similar to Telegram:

- User messages: plain text block.
- Assistant messages: render text blocks; optionally render thinking blocks and tool calls.
- Tool result messages: render tool name + result content.

Add a toggle bar (Base UI) for:

- Tool calls (default: hidden)
- Thinking blocks (default: hidden)
- Trace events (default: hidden)
- Usage/cost (default: hidden)

Include a **Refresh** button to re-fetch the session detail.

### 8.4 Session creation

Add a form at the top of Sessions list view:

- Harness selector (required)
- Provider/model selector (required, from `PI_MODEL_CATALOG`)
- Name (optional)
- Steering mode (required, default `one-at-a-time`)
- Tags (optional)
- Metadata (optional JSON)

Submit to `POST /sessions` using computed agent name and redirect to the new session detail.

No UI for sending messages in v1.

## 9. Security & Access Control

- Require authenticated user (`getAuthMe`) and org membership for all backoffice routes.
- DO admin methods and session routes are only accessible via server loaders/actions.
- No external public endpoints besides the proxied fragment routes.

## 10. Validation & Limits

- Validate harness IDs exist before session creation.
- Validate provider/model exist in `PI_MODEL_CATALOG`.
- Validate harness tool IDs against the static registry.
- Enforce max session list limit (use Pi route default or explicit `limit` query).

## 11. Operational Concerns

- `migrate()` must run for Pi and Workflows fragments on DO startup (block concurrency).
- Durable hooks dispatcher should be created for both fragments to advance workflows.
- Errors from the dispatcher should be logged but not crash the DO.
- In-memory VFS is per DO instance and is **not** persisted across evictions/restarts.

## 12. Decisions (Locked)

- Providers supported: OpenAI, Anthropic, Gemini.
- Sessions are scoped per org using a Cloudflare Durable Object keyed by `orgId`.
- Workflows fragment stays internal (no public API route).
- Sessions are read-only in v1 (no manual message sending).
- Harnesses are read-only in the UI.
- Layout and route structure mirror Telegram backoffice patterns.
- Tool registry includes a bash tool from just-bash with an in-memory VFS.
- Model dropdown includes only newest models per provider; Gemini 3 models are preview.
- VFS is in-memory and ephemeral (no persistence in v1).

## 13. Documentation Updates

- Add a short note to backoffice docs (if any) describing where Pi Sessions live and how to
  configure harnesses + API keys.
