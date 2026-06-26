---
name: backoffice-codemode
description:
  Interact with the local Fragno Backoffice dev system through its dev codemode routes. Use when
  debugging or inspecting the running backoffice app, automation/event/workflow/Pi/runtime-tool
  behavior, org-scoped filesystems, or when asked to run codemode scripts in the context of the
  backoffice runtime.
---

# Backoffice Codemode

Use the running Backoffice dev server as the source of truth for runtime behavior. The server is
usually `http://localhost:5173`, but may be on another Vite port such as `5174`.

Use `scripts/codemode.mjs` for auth, org discovery, and codemode calls. It stores local JWT state in
`.agents/skills/backoffice-codemode/auth.json`; this file is gitignored. Default dev credentials are
`wilco@rejot.dev` / `wachtwoord`.

## Required workflow

1. Run the canonical bootstrap command.

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs login
   ```

   `login` always probes the running Backoffice server, warns if multiple matching dev servers are
   running, refreshes or signs in with the default dev credentials, stores auth state, and prints
   the authenticated user plus accessible orgs. Prefer `active`; otherwise use the only org or ask
   the user which org id to use. Never run codemode for an org not listed here.

   `probe` exists only as a low-level debug command to print the detected base URL.

2. Fetch and read the org-scoped rendered codemode system prompt.

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs system "$ORG_ID" /tmp/backoffice-codemode-SYSTEM.md
   ```

   If `$ORG_ID` is omitted, `system` uses the first organization returned for the logged-in user.
   Then read `/tmp/backoffice-codemode-SYSTEM.md`. Treat it as authoritative for available
   `state.*`, workflow helpers, and runtime tool providers. The route reads the org's existing
   `/workspace/codemode/system.d.ts` index and includes the generated state and scoped context
   declarations inline.

3. Run codemode through the authenticated dev route when you need to execute in the Backoffice
   runtime. The helper auto-authenticates if needed.

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" 'async () => { return await state.readdir("/"); }'
   ```

   For larger snippets, prefer a temp file or stdin:

   ```bash
   .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" --file /tmp/snippet.js
   printf '%s\n' 'async () => await state.readdir("/")' \
     | .agents/skills/backoffice-codemode/scripts/codemode.mjs exec "$ORG_ID" -
   ```

   The body supports `code` and optional `timeout`. It intentionally does not mount
   `/context/event.json`; it mirrors the Pi `execCodeMode` tool by using the org filesystem plus
   route-backed domain tools.

## Relevant code

Inspect code when runtime behavior is unclear. Relevant areas:

- `apps/backoffice/app/fragno/runtime-tools/*` — runtime tool definitions/providers.
- `apps/backoffice/app/fragno/automation/*` — automation ingestion, bindings, and execution.
- `apps/backoffice/app/fragno/pi/*` — Pi `execCodeMode` behavior and harness prompts.
- `apps/backoffice/app/fragno/codemode/workflow-*` and
  `runtime-tools/families/automations-workflow*` — workflow codemode behavior.
- `apps/backoffice/app/fragno/codemode/*` — dynamic-worker execution and filesystem state.

## Safety and expectations

- These routes are dev-only, localhost-only.
- Dynamic Worker code has no direct outbound network by default. Use exposed domain tools for
  Backoffice effects.
- Prefer small, inspectable codemode snippets. Return JSON-serializable objects with observations,
  file paths changed, and tool call results.
- For filesystem edits, prefer `state.planEdits()` then `state.applyEditPlan()`.

## Bash route

Use the dev bash route when a dashboard-style shell command is enough and codemode is unnecessary:

```bash
.agents/skills/backoffice-codemode/scripts/codemode.mjs bash "$ORG_ID" 'ls /workspace'
.agents/skills/backoffice-codemode/scripts/codemode.mjs bash "$ORG_ID" --cwd /workspace 'find . -maxdepth 2'
printf '%s\n' 'pwd && ls' | .agents/skills/backoffice-codemode/scripts/codemode.mjs bash "$ORG_ID" -
```

It calls `POST /__dev/codemode/:orgId/bash`, runs against the org filesystem with the same
runtime-tool bash adapter as the dashboard terminal, and returns `stdout`, `stderr`, combined
`output`, `exitCode`, `nextCwd`, and runtime `commandCalls`.

## Debugging examples

List root mounts:

```js
async () => {
  return await state.readdir("/");
};
```

Inspect automation files:

```js
async () => {
  const files = await state.find("/workspace/automations", { type: "file", maxDepth: 4 });
  return files.map((file) => file.path);
};
```

Find errored workflow instances:

```js
async () => {
  const { workflows } = await workflow.listWorkflows({});
  const results = [];

  for (const item of workflows) {
    const errored = await workflow.listInstances({
      workflowName: item.name,
      status: "errored",
      pageSize: 20,
    });

    results.push({ workflowName: item.name, instances: errored.instances });
  }

  return results.filter((entry) => entry.instances.length > 0);
};
```

Inspect why a specific workflow instance failed:

```js
async () => {
  const workflowName = "automation-codemode-script";
  const instanceId = "paste-instance-id-here";

  const instance = await workflow.getInstance({ workflowName, instanceId });
  const history = await workflow.getHistory({ workflowName, instanceId });

  return {
    status: instance.details.status,
    error: instance.details.error,
    meta: instance.meta,
    failedSteps: history.steps.filter((step) => step.status === "errored"),
  };
};
```
