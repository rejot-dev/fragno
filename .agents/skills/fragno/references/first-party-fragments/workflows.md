# Workflows Fragment (`@fragno-dev/workflows`)

## Integration boundary

Use the `fragno-workflows` skill for workflow definitions, replay-safe step design, fragment and
dispatcher setup, events, emissions, instance behavior, and tests. This reference covers integrating
an already-designed Workflows fragment into its host application.

## Summary

Fragno Workflows runs durable, replayable processes with steps, retries, timers, and event waits.
Workflow state is stored in the application's database and managed through fragment services, typed
clients, or HTTP routes.

## Prerequisites

- `@fragno-dev/workflows` and `@fragno-dev/db`
- A supported Fragno database adapter
- Applied fragment migrations
- A durable-hooks dispatcher that processes enqueued workflow ticks

## Host integration

1. Create the server instance with `createWorkflowsFragment`, the workflow registry,
   `defaultFragnoRuntime`, and the application's database adapter.
2. Start a Node durable-hooks processor or host the fragment in the Cloudflare Durable Object
   dispatcher.
3. Mount the fragment routes, normally under `/api/workflows`.
4. Protect the mounted routes with the application's authentication and authorization middleware.
5. Generate and apply migrations with `fragno-cli db generate` and the application's migration
   workflow.

## Public management surface

The HTTP API supports:

- Listing registered workflows and cursor-paginated instances
- Creating one instance or a batch of at most 100
- Reading status, history, and current-step emissions
- Sending idempotent events
- Pausing, resuming, retrying, and terminating instances

Use fragment services for server-to-server calls when an HTTP round trip is unnecessary.

## Current docs

- Quickstart: `curl -L "https://fragno.dev/docs/workflows/quickstart" -H "accept: text/markdown"`
- Rules of Workflows:
  `curl -L "https://fragno.dev/docs/workflows/rules-of-workflows" -H "accept: text/markdown"`
- Dispatcher and hooks:
  `curl -L "https://fragno.dev/docs/workflows/runner-dispatcher" -H "accept: text/markdown"`
- API routes: `curl -L "https://fragno.dev/docs/workflows/routes" -H "accept: text/markdown"`
- Workflow testing: `curl -L "https://fragno.dev/docs/workflows/testing" -H "accept: text/markdown"`
