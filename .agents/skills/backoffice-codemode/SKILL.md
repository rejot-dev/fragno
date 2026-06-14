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

This skill is usually invoked when the user wants to fix bugs in the backoffice codebase
(`apps/backoffice`).

## Required workflow

1. Probe the running server before assuming a port or org id. Try Vite ports in order and use the
   first `200` response:

   ```bash
   for port in 5173 5174 5175 5176 5177 5178 5179 5180; do
     base_url="http://localhost:$port"
     status=$(curl -sS -o /tmp/backoffice-dev-health.json -w '%{http_code}' "$base_url/__dev" || true)
     if [ "$status" = "200" ]; then
       echo "$base_url"
       cat /tmp/backoffice-dev-health.json
       break
     fi
   done
   ```

2. Read the health JSON.
   - The printed URL is the `BASE_URL` to use.
   - `organizations[]` lists available orgs for the current browser/session cookies, when any.
   - Prefer an active organization (`isActive: true`); otherwise ask the user which org id to use or
     use the only available org.
   - If no orgs are listed, the health route is still valid; ask the user for an org id or inspect
     the app/auth state.

3. Fetch and read the org-scoped rendered codemode instructions from the running system.

   ```bash
   curl -sS "$BASE_URL/__dev/codemode/$ORG_ID/AGENTS.md" -o /tmp/backoffice-codemode-AGENTS.md
   ```

   Then read `/tmp/backoffice-codemode-AGENTS.md`. Treat it as authoritative for available
   `state.*`, workflow helpers, and runtime tool providers. The route reads the org's existing
   `/workspace/codemode.d.ts` file and returns those declarations inline.

4. Inspect code when runtime behavior is unclear. Relevant areas:
   - `apps/backoffice/app/routes/dev/*` — dev health, codemode, and prompt routes.
   - `apps/backoffice/app/fragno/codemode/*` — dynamic-worker execution and filesystem state.
   - `apps/backoffice/app/fragno/runtime-tools/*` — runtime tool definitions/providers.
   - `apps/backoffice/app/fragno/automation/*` — automation ingestion, bindings, and execution.
   - `apps/backoffice/app/fragno/pi/*` — Pi `execCodeMode` behavior and harness prompts.
   - `apps/backoffice/app/fragno/codemode/workflow-*` and
     `runtime-tools/families/automations-workflow*` — workflow codemode behavior.

5. Run codemode through the dev route when you need to execute in the Backoffice runtime:

   ```bash
   curl -sS -X POST "$BASE_URL/__dev/codemode/$ORG_ID" \
     -H 'content-type: application/json' \
     --data '{"code":"async () => { return await state.readdir(\"/\"); }"}'
   ```

   The body supports `code` and optional `timeout`. It intentionally does not mount
   `/context/event.json`; it mirrors the Pi `execCodeMode` tool by using the org filesystem plus
   route-backed domain tools.

## Safety and expectations

- These routes are dev-only and localhost-only. If probing returns 404, verify the app is running in
  development mode and try the next port.
- Do not add authentication assumptions to `__dev/*`; these routes are intentionally outside the
  Backoffice authenticated layout.
- Dynamic Worker code has no direct outbound network by default. Use exposed domain tools for
  Backoffice effects.
- Prefer small, inspectable codemode snippets. Return JSON-serializable objects with observations,
  file paths changed, and tool call results.
- For filesystem edits, prefer `state.planEdits()` then `state.applyEditPlan()`.

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

Create a workflow instance if the rendered `AGENTS.md` shows workflow tools are available:

```js
async () => {
  return await workflow.createInstance({
    workflowName: "example",
    instanceId: `dev-${crypto.randomUUID()}`,
    params: { source: "backoffice-codemode skill" },
  });
};
```
