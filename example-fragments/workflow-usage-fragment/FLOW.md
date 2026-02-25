# Workflow Usage Fragment – Step-by-Step Flow

This guide walks through verifying the workflow-usage-fragment works end-to-end after a fresh
database.

## Steps

### 0. Delete the database (and stop the server if running)

Stop the server if it's running, then remove the database file:

```bash
lsof -ti:4100 | xargs kill -9   # stop server if running
rm -f usage-fragment.sqlite     # delete the DB (or WORKFLOW_USAGE_DB_PATH if set)
```

### 1. Start the test server

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment serve
```

The server listens on `http://127.0.0.1:4100/api/workflow-usage-fragment`. With a missing DB file,
it creates the schema on first use.

### 2. List sessions

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions list
```

Expected: `[]` with a fresh database.

### 3. Create a session (calculator agent)

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions create --agent calculator
```

Expected: JSON with `id`, `workflowInstanceId`, `status: "active"`. Copy the `id` for later steps.

### 4. Get session details (before event)

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions get --id <sessionId>
```

Expected: `workflow.status: "waiting"`, no `dslState` yet.

### 5. Send event to run and complete the workflow

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions send-event --id <sessionId> --payload '{"text":"compute","done":true}'
```

The `"done": true` tells the workflow to finish after running the DSL. The event is queued and
processed by the background dispatcher.

### 6. Wait for dispatcher

Wait 1–2 seconds so the durable hooks dispatcher can advance the workflow and run all calculator DSL
steps (product, quotient, difference, roll, triple).

### 7. Get session again

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions get --id <sessionId>
```

Expected: `workflow.status: "complete"`, `dslState` present with calculator results:

```json
"dslState": {
  "product": 32,
  "quotient": 6,
  "difference": 77,
  "roll": 14,
  "triple": 51
}
```

- `product`: `(5 + 3) * 4` → 32
- `quotient`: `42 / 7` → 6
- `difference`: `100 - 23` → 77
- `roll`: random 1–20
- `triple`: `17 * 3` → 51

---

## AI Prompt

Explain the entire session: what the workflow-usage-fragment does, how the CLI and server interact,
how events move through the system, and why `dslState` appears only after waiting for the
dispatcher.
