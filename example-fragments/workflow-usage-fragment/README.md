# Workflow Usage Fragment

This example fragment shows how to wire a user-defined agent DSL on top of the Fragno workflows
engine. It ships with:

- A test server entrypoint that runs the usage fragment plus background hook processing.
- A small CLI (`workflow-usage`) to hit the fragment routes.

## Build

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment build
```

## Start The Test Server

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment serve
```

Defaults:

- Host: `127.0.0.1`
- Port: `4100`
- Usage fragment mount: `/api/workflow-usage-fragment`
- Agents: `default`, `calculator`
- Database path: `./usage-fragment.sqlite`

You can override via flags or env:

```bash
pnpm --filter ./example-fragments/workflow-usage-fragment serve -- --port 4200 --db-path ./tmp/usage.sqlite
```

Environment variables:

- `WORKFLOW_USAGE_PORT`
- `WORKFLOW_USAGE_HOST`
- `WORKFLOW_USAGE_DB_PATH`

## CLI Usage

The CLI assumes the usage fragment is mounted at
`http://127.0.0.1:4100/api/workflow-usage-fragment`. Set `WORKFLOW_USAGE_BASE_URL` or `BASE_URL` to
override:

```bash
export WORKFLOW_USAGE_BASE_URL="http://127.0.0.1:4200/api/workflow-usage-fragment"
# or
export BASE_URL="http://127.0.0.1:4200/api/workflow-usage-fragment"
```

```bash
# List sessions
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions list

# Create a session
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions create --agent default
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions create --agent calculator

# Fetch session details
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions get --id <sessionId>

# Send an event (default type: user_message)
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions send-event --id <sessionId> --payload '{"text":"hi"}'

# After sending, wait ~1 second for the background dispatcher to run the workflow, then fetch again:
pnpm --filter ./example-fragments/workflow-usage-fragment cli sessions get --id <sessionId>
```

## Agent DSL

Each agent definition can include a tiny DSL used by the test runner to simulate work. The DSL is a
list of steps:

- `wait`: sleep for a duration (e.g. `"250ms"`, `"2s"`, `500`).
- `calc`: evaluate a simple arithmetic expression. Use `$varname` to reference variables from
  earlier steps.
- `random`: generate a random number with optional rounding.
- `input`: read a numeric value from the event payload by key and assign to a variable.

Example:

```ts
const agent = {
  systemPrompt: "...",
  dsl: {
    steps: [
      { type: "wait", duration: "250ms", label: "thinking" },
      { type: "calc", expression: "2 + 2", assign: "sum" },
      { type: "random", min: 1, max: 10, round: "round", assign: "roll" },
      { type: "input", key: "amount", assign: "amount" }, // from payload.amount
      { type: "calc", expression: "$amount * 2", assign: "doubled" }, // $varname interpolation
    ],
  },
};
```

## How It Works

- The test server spins up the usage fragment plus a background hook processor.
- The usage fragment persists sessions in its own database schema.
- On session creation, it creates a workflow instance and stores the instance ID.
- Sending events forwards to the internal engine; the runner waits on `user_message` events.
- When a payload includes `{ "done": true }`, the workflow completes.

## Notes

- This demo workflow does not invoke any LLMs.
- Uses a SQLite database (`./usage-fragment.sqlite`) so data persists between restarts.
