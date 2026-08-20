---
name: backoffice-codemode
description:
  Use the local Backoffice dev runtime for authenticated codemode, filesystem, Pi session, workflow,
  event, and runtime-provider inspection.
disable-model-invocation: true
---

# Backoffice Codemode

Treat the running Backoffice dev server as the source of truth. Use `scripts/codemode.mjs`; it
handles Better Auth, organization-scoped JWTs, scoped dev routes, and local auth state in the
gitignored `auth.json`.

Default credentials are `wilco@rejot.dev` / `wachtwoord`. Set `BACKOFFICE_URL` or pass
`--base-url URL` when more than one server is running.

## Required workflow

1. **Bootstrap.**

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs login
   ```

   The command probes `/api/auth/ok`, restores or creates a Better Auth session, exchanges it for a
   Backoffice JWT, and prints the authenticated user and accessible organizations. Prefer `active`;
   otherwise use the only organization or ask the user. Proceed only with an organization printed by
   `login`.

   For an explicit server or account:

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs login \
     --base-url http://localhost:5173 \
     --email wilco@rejot.dev \
     --password wachtwoord
   ```

   Completion: the output names the intended server, user, and organization.

2. **Load runtime declarations.**

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs system \
     "$ORG_ID" /tmp/backoffice-codemode-SYSTEM.md
   ```

   Read `/tmp/backoffice-codemode-SYSTEM.md`. Treat it as authoritative. Before using a provider,
   read its referenced declaration with `state.readFile({ path: ... })`; provider names and input
   shapes can change.

   Completion: the selected provider and method exist in the rendered declarations.

3. **Execute one inspectable operation.**

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" \
     'async () => ({ entries: await state.readdir({ path: "/" }) })'
   ```

   For larger snippets, use a temporary file or stdin:

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" --file /tmp/snippet.js
   printf '%s\n' 'async () => await state.readdir({ path: "/" })' \
     | .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" -
   ```

   Return JSON-serializable observations and tool results. Completion: the executed result directly
   supports the conclusion reported to the user.

## Diagnostics

Run the read-only end-to-end check when authentication, routing, or codemode execution is unclear:

```bash
.agents/skills/backoffice-codemode/scripts/codemode.mjs doctor \
  --base-url http://localhost:5173
```

It verifies server discovery, Better Auth restoration, JWT exchange, `/api/backoffice/me`, SYSTEM
prompt retrieval, and a read-only codemode call.

`probe` only identifies the selected server:

```bash
.agents/skills/backoffice-codemode/scripts/codemode.mjs probe --base-url http://localhost:5173
```

## Provider selection

Read the provider declaration before calling it:

```js
async () => ({
  pi: await state.readFile({ path: "/static/codemode/providers/pi.d.ts" }),
  workflow: await state.readFile({ path: "/static/codemode/providers/workflow.d.ts" }),
});
```

- **Pi chat sessions**, including URLs containing `interactive-chat-workflow`: use `pi.getSession`.
- **Saved durable workflow instances**: use `workflow.getInstance` and `workflow.getHistory`.
- **Filesystem inspection**: use the declared `state` object-input methods such as `readFile`,
  `readdir`, `glob`, and `searchFiles`.

Inspect a Pi session:

```js
async () =>
  await pi.getSession({
    sessionId: "paste-session-id-here",
    events: true,
    trace: true,
    turns: true,
  });
```

Inspect a durable workflow instance:

```js
async () => {
  const instanceId = "paste-instance-id-here";
  const [instance, history] = await Promise.all([
    workflow.getInstance({ instanceId }),
    workflow.getHistory({ instanceId }),
  ]);
  return { instance, history };
};
```

List errored durable workflow instances:

```js
async () => await workflow.listInstances({ status: "errored", pageSize: 20 });
```

Inspect automation files:

```js
async () => await state.glob({ pattern: "/workspace/automations/**" });
```

## Bash route

Use bash for shell-shaped filesystem inspection:

```bash
.agents/skills/backoffice-codemode/scripts/codemode.mjs bash "$ORG_ID" 'ls /workspace'
.agents/skills/backoffice-codemode/scripts/codemode.mjs bash "$ORG_ID" \
  --cwd /workspace 'find . -maxdepth 2'
```

The helper calls the scope-aware `/__dev/codemode/org/:orgId/bash` route and returns output,
`exitCode`, `nextCwd`, and runtime command calls.

## Safety

- Dev routes are localhost-only.
- Use exposed providers for external effects; Dynamic Worker code has no direct outbound network.
- Prefer small read-only snippets during diagnosis.
- For filesystem changes, inspect first and use the currently declared atomic edit method, typically
  `state.applyEdits`.

## Code pointers

Inspect implementation only when rendered runtime behavior is insufficient:

- `apps/backoffice/app/fragno/runtime-tools/*`
- `apps/backoffice/app/fragno/automation/*`
- `apps/backoffice/app/fragno/pi/*`
- `apps/backoffice/app/fragno/codemode/*`
