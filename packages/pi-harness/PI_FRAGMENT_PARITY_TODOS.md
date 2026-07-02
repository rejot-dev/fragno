# pi-fragment parity todos

Quick parity checklist for `@fragno-dev/pi-harness` vs the old `@fragno-dev/pi-fragment`.

## Must have before replacing pi-fragment

- [x] Restore Pi JSONL export support.
  - [x] Redesign around Pi-native `SessionStorage` / `SessionTreeEntry` export.
  - [x] Add `GET /workflows/:workflowName/sessions/:sessionId/export/pi-jsonl`.
  - [x] Add route/helper tests equivalent to the old `pi-jsonl-export.test.ts`.
- [x] Make session list/status behavior intentional.
  - [x] Keep the `session` table as a route/list index only.
  - [x] Remove `session.status`; workflow status is exposed under `detail.workflow.status` and
        command acknowledgements.
- [ ] Improve recovery coverage beyond prompt-like partials.
  - [x] Handle partial prompt-like retries ending in `toolResult` by rerunning from the initial
        prompt. Tool execution is expected to be idempotent across workflow retries.
  - [ ] Handle or explicitly document partial `compact` / `navigateTree` / other non-prompt
        operations.
  - [x] Add crash-window tests for assistant-entry-emitted-before-operation-complete.
- [x] Port route/events compatibility tests that still describe desired behavior.
  - [x] Session creation/list/detail.
  - [x] Event stream initial snapshot + in-flight emissions.
  - [x] Command acknowledgement/error cases.
- [x] Port focused client reducer unit tests for harness emissions.

## Nice to have / compatibility choices

- [ ] Decide whether to bring back a CLI for `pi-harness`.
- [ ] Decide whether to provide a migration guide from `definePiWorkflow(...)` / `createPi()` to
      `defineWorkflow(...)` / `createAgentLoop(...)`.
- [ ] Decide whether old dynamic tool factories are intentionally replaced by user-owned harness
      construction.
- [ ] Decide whether session detail should expose historical events, or only committed transcript
      state plus live events.
- [ ] Decide whether the package should keep aliases like `createPiFragmentClients` long term or
      rename them to harness names.

## Already intentionally different

- [x] No package-root barrel export; use logical subpath exports.
- [x] No custom Pi workflow runtime; use normal `defineWorkflow(...)`.
- [x] No durable `session_entry` table; workflow history/emissions are transcript source of truth.
- [x] No lower-level `Agent`; use `AgentHarness`.
- [x] User-owned `env`; no durable env filesystem in pi-harness.
