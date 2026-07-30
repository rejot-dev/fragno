# Backoffice json-render session UI plan

## Goal

Allow the Backoffice Pi agent to return generated interfaces from `execCodeMode` and inline codemode
workflows. Render those interfaces directly in the current Backoffice session detail UI:

```text
apps/backoffice/app/routes/backoffice/sessions/session-detail/
```

The implementation must follow the current Backoffice visual language and session architecture. The
outdated Cadence prompt, transcript, companion-panel, and workflow-workbench code is not an
implementation source and must not be reused.

## Required references

Read these files completely before implementing the first slice, and revisit them when changing the
catalog, result contract, registry, or renderer:

- [`.agents/skills/core/SKILL.md`](../.agents/skills/core/SKILL.md) — json-render schemas, catalogs,
  prompt generation, validation, state, and spec utilities.
- [`.agents/skills/react/SKILL.md`](../.agents/skills/react/SKILL.md) — the React schema, registry,
  renderer, providers, dynamic props, events, and bindings.

The checked-in skill examples are guidance, but the implementation must confirm the canonical spec
shape exported by the installed `@json-render/react` version. Runtime validation, tests, examples,
and the Backoffice agent skill must all use that same shape.

## Decisions

- Generated UI is recognized only through an explicit, versioned top-level `$ui` sidecar.
- Ordinary codemode values retain their current text/JSON presentation.
- `$ui` is a sidecar rather than a wrapper so workflow results can retain fields needed by later
  steps.
- Only the top-level result is inspected. The renderer does not recursively search arbitrary values
  for UI specifications.
- The initial catalog is presentation-focused and does not expose arbitrary HTML, CSS, JavaScript,
  network actions, or unrestricted embeds.
- Immediate codemode UI renders inside the existing `execCodeMode` tool result card.
- Inline workflow status, final output, and step results also render inside that tool result card.
- Detailed authoring guidance lives in a discoverable Backoffice skill, not in the system prompt.
- Catalog definitions are canonical: runtime validation, the React registry, examples, and the agent
  skill derive from the same definitions.

## Result contract

A returned object may attach a versioned presentation without hiding its ordinary data:

```js
return {
  orders,
  total: orders.length,
  $ui: {
    version: 1,
    state: { orders },
    spec: {
      root: "report",
      elements: {
        report: {
          type: "Stack",
          props: { gap: "md" },
          children: ["summary", "orders"],
        },
        summary: {
          type: "Metric",
          props: { label: "Orders", value: String(orders.length) },
          children: [],
        },
        orders: {
          type: "Table",
          props: {
            columns: ["ID", "Status"],
            rows: orders.map((order) => [order.id, order.status]),
          },
          children: [],
        },
      },
    },
  },
};
```

The same contract applies to a durable step result:

```js
const report = await step.do("build report", async () => {
  const orders = await loadOrders();
  return {
    orders,
    $ui: {
      version: 1,
      state: { orders },
      spec: buildOrdersSpec(orders),
    },
  };
});

await step.do("process orders", async () => {
  return await processOrders(report.orders);
});
```

## Vertical slices

Each slice must leave the application in a working state and have focused automated tests that prove
its behavior through the production boundary introduced by that slice. Do not build all foundation
modules first and defer integration until the end.

### - [x] Slice 1 — Render an immediate codemode UI in the session tool card

**User-visible outcome:** an `async () => ...` `execCodeMode` call can return a small `$ui` result,
and the existing Backoffice session detail tool card renders it instead of showing the spec as raw
JSON.

Implement the narrowest complete path:

- Add compatible, pinned `@json-render/core` and `@json-render/react` dependencies to
  `apps/backoffice/package.json`.
- Confirm the installed React schema shape and use it consistently.
- Add a shared Backoffice UI module with isomorphic catalog/result boundaries and separately
  importable React renderers:

  ```text
  apps/backoffice/app/backoffice-ui/
    catalog.ts
    result.ts
    registry.ts
    renderer.tsx
    components/
  ```

- Define `BackofficeUiResultV1` and a `parseBackofficeUiResult(value: unknown)` trust boundary.
- Recognize only a top-level `$ui` with `version: 1`.
- Create a minimal catalog containing only enough components for the first fixture:
  - `Stack`;
  - `Heading`;
  - `Text`;
  - `Metric`.
- Add the session-specific result presenter under:

  ```text
  apps/backoffice/app/routes/backoffice/sessions/session-detail/
    result-content.tsx
  ```

- Style the components with current `--bo-*` variables and Backoffice geometry; do not import
  Cadence components.
- Update `tool-call.tsx` to read the raw value from `completedToolResult.details.result` and pass it
  to `ResultContent`.
- Keep logs separate from the returned value.
- Keep the existing tool card summary and expansion interaction.
- Keep full raw output available behind an explicit debugging disclosure.

Automated proof:

- Parser test for a valid `$ui` result.
- Server-rendered React test for the minimal generated interface.
- `assistant-runtime` or result-projection test proving `details.result` reaches the tool card.
- Tool result rendering test proving the generated UI path is chosen for `execCodeMode`.
- Cloudflare codemode test proving an immediate `$ui` object survives `execCodeMode` unchanged in
  `details.result`.

The slice is complete when a live Backoffice session can execute a fixture codemode call and render
its generated metric interface inside the existing tool card.

### - [x] Slice 2 — Preserve ordinary output and safely reject malformed generated UI

**User-visible outcome:** adopting `$ui` does not regress existing codemode output, valid generated
interfaces open automatically ahead of debugging details, and invalid agent specifications produce a
useful fallback rather than breaking the session thread.

Extend the result boundary and presenter:

- Return a discriminated parse result for:
  - valid generated UI;
  - tagged but invalid generated UI;
  - ordinary non-UI output.
- Automatically open completed tool cards containing valid or invalid tagged generated UI while
  leaving ordinary tool cards closed by default.
- Present generated UI or its failure notice before code and logs; keep code, logs, and raw output
  behind separate disclosures for tagged results.
- Validate that the root exists and child references resolve.
- Validate component names against the catalog.
- Validate component props with their canonical Zod schemas.
- Reject unsupported actions and event bindings in this first version.
- Add explicit structural limits: 128 elements, 32 children per element, 512 total child references,
  and 24 levels. Do not impose a serialized-byte limit on generated UI state.
- Add a local React error boundary around json-render output.
- Render tagged-but-invalid output as a compact `--bo-failed` notice with:
  - a concise validation message;
  - an explicit raw-value disclosure;
  - no uncaught exception.
- Preserve existing behavior for strings, JSON objects, images, errors, and non-codemode tools.
- Keep codemode logs in a separate bounded section.
- Avoid putting a successfully rendered `$ui.spec` in the default visible `<pre>`.

Automated proof:

- Parser tests for ordinary values, unsupported versions, missing roots, dangling children, unknown
  components, invalid props, structural limits, and large state payloads.
- Renderer test proving a component exception is contained by the local error boundary.
- Tool-card tests for ordinary JSON, strings, logs, invalid UI, and non-codemode results.
- Client rendering tests proving tagged results auto-open, ordinary results remain closed, raw
  output remains disclosed, and component exceptions render the local fallback.
- Regression test for the existing expanded codemode result behavior when no `$ui` is present.

The slice is complete when malformed UI cannot blank the thread and all existing result types remain
readable.

### - [ ] Slice 3 — Ship the useful Backoffice presentation catalog

**User-visible outcome:** the agent can present realistic Backoffice reports, summaries, lists, and
tables rather than only the minimal metric fixture.

Expand the canonical catalog with strict, Backoffice-specific components:

- Layout:
  - `Stack`;
  - `Grid`;
  - `Section`;
  - `Divider`.
- Content:
  - `Heading`;
  - `Text`;
  - `Code`;
  - `Callout`.
- Data:
  - `Metric`;
  - `Badge`;
  - `KeyValue`;
  - `List`;
  - `Table`;
  - `Progress`.

For every component:

- Define a strict prop schema.
- Define a description suitable for agent guidance.
- Define a representative example.
- Use semantic variants such as neutral, accent, live, warning, and failed instead of arbitrary
  colors.
- Use current Backoffice variables including `--bo-panel`, `--bo-panel-2`, `--bo-border`, `--bo-fg`,
  `--bo-muted`, `--bo-accent`, `--bo-live`, and `--bo-failed`.
- Match current Backoffice density, square-edged bordered surfaces, compact uppercase labels, and
  restrained typography.
- Keep wide tables horizontally scrollable with `backoffice-scroll`.
- Bound large tables and lists so generated output remains usable inside `max-w-3xl` session
  threads.
- Do not accept raw HTML, raw class names, inline styles, scripts, iframes, or arbitrary URLs.
- Keep the catalog read-only. Interactive actions require a separate design for lifecycle,
  authorization, and persistence.

Automated proof:

- Catalog validation tests covering one valid and one invalid fixture for every component.
- Server-rendered fixture for a representative Backoffice report using layout, metrics, badges,
  key/value data, and a table.
- Accessibility assertions for headings, lists, tables, progress semantics, and status text.
- Limit tests for oversized tables and lists.

The slice is complete when a single codemode result can render a useful multi-section Backoffice
report with no custom component code in the result.

### - [x] Slice 4 — Teach immediate UI generation through a Backoffice skill

**User-visible outcome:** when a user asks for a dashboard, report, table, or visual summary, the Pi
agent can discover the skill and return a valid interface using the production catalog.

Add a product-owned skill at:

```text
/static/skills/generating-backoffice-uis/SKILL.md
```

Implement it through `apps/backoffice/app/files/content/skills.ts` or a dedicated generated skill
module imported by that file.

The skill must:

- Have a description that triggers for dashboards, reports, tables, metrics, visual summaries, and
  requests to present retrieved data visually.
- Document the exact `$ui.version === 1` contract.
- Document the installed json-render spec shape.
- Include an immediate `async () => ...` example.
- Explain how ordinary data fields remain beside `$ui`.
- Require the agent to retrieve real Backoffice data before constructing the interface.
- Forbid invented operational data, placeholder records, unsupported components, arbitrary styles,
  and raw HTML.
- Require catalog components only.
- Tell the agent not to repeat the generated interface as a large Markdown table after returning it.

Keep the catalog canonical:

- Generate the skill's component reference from the same component definitions used by runtime
  validation and the React registry.
- Use `catalog.prompt()` only if its generated rules are appropriate for Backoffice.
- If it introduces generic sample-data or conflicting instructions, use a Backoffice-specific prompt
  template instead.
- Do not add component documentation or `$ui` authoring instructions to `STATIC_GUIDANCE_MD`.
- Leave the existing generic skill discovery instructions unchanged.

Automated proof:

- Static filesystem test proving the skill exists at the expected path.
- Skill loader test proving Pi advertises the skill.
- Contract test proving every canonical catalog component appears in the generated skill.
- Test proving the skill examples parse through `parseBackofficeUiResult` and the production
  catalog.
- Test proving `STATIC_GUIDANCE_MD` does not contain the generated catalog or detailed `$ui`
  instructions.

The slice is complete when a live Pi session can read the skill and generate a valid immediate
Backoffice report without relying on new system-prompt guidance.

### - [ ] Slice 5 — Render an inline workflow's terminal UI result

**User-visible outcome:** an inline `defineWorkflow` started by `execCodeMode` stays represented in
its existing tool card, shows live status, and renders its final `$ui` output when complete.

Use the run handle already returned in `completedToolResult.details.run`:

- Define and validate the `{ workflowName, instanceId }` run-handle shape.
- Add a session-detail-specific workflow hook, for example in `workflow-result.tsx` or a nearby
  module.
- Use the active organisation/scope from the sessions route context to construct workflow requests.
- Pass the required scope information from `session-detail.tsx` through the assistant-ui message
  rendering boundary without creating hidden globals.
- Load workflow instance status while the tool card is mounted.
- Poll while the instance is active, waiting, or paused.
- Stop on complete, errored, or terminated status.
- Abort requests when the card unmounts or the session changes.
- Treat temporary request failures as retryable presentation state rather than changing the original
  tool call to failed.
- Render a compact Backoffice workflow status section inside the expanded tool card.
- Read the terminal output from the instance status response.
- Pass terminal output through the same `ResultContent` used for immediate results.
- Render ordinary final values as text/JSON and `$ui` final values through json-render.
- Do not present the initial run handle as the workflow's final result.
- Do not add graphs, workbenches, companion panels, or Cadence code.

Automated proof:

- Run-handle parser tests.
- Hook tests for active polling, terminal shutdown, unmount abort, and transient request errors.
- Tool-card test for active, waiting, completed, errored, and terminated status.
- Workflow integration test proving a terminal `$ui` result survives status serialization.
- Rendering test proving the terminal `$ui` result uses the same production presenter as an
  immediate result.

The slice is complete when a live inline workflow can finish and replace its run-handle-only state
with a rendered final interface in the original session tool card.

### - [ ] Slice 6 — Render durable UI results from inline workflow steps

**User-visible outcome:** users can inspect generated interfaces returned by individual `step.do`
operations while retaining workflow status, attempts, and errors.

Use persisted workflow history rather than introducing a new result channel:

- Extend the session-detail workflow hook to load instance history with status.
- Project history steps into a route-local view model containing:
  - step key;
  - parent step key and depth;
  - name and type;
  - status;
  - attempts and maximum attempts;
  - error;
  - timestamps;
  - result.
- Render steps as compact bordered Backoffice rows inside the expanded `execCodeMode` card.
- Show waiting, retrying, errored, and completed states without graph nodes.
- Add an expandable result region for completed steps with non-null results.
- Pass each step result through the shared `ResultContent` component.
- Auto-expand the newest completed step whose result contains valid `$ui`.
- Keep older step results collapsed so long workflows do not overwhelm the session.
- Preserve attempt and error details for debugging.
- Confirm `$ui` values are replay-safe plain data and round-trip unchanged through step persistence.
- Confirm downstream workflow code can still consume non-UI fields from the same result object.

Automated proof:

- History projection tests for ordering, nesting, attempts, errors, and results.
- Workflow harness test in which a `step.do` returns ordinary data plus `$ui`.
- Assertion that persisted history contains the unchanged `$ui` value after replay.
- Assertion that a later step consumes a non-UI field from the same persisted result.
- Tool-card rendering test for a workflow containing ordinary, generated-UI, waiting, and errored
  step results.
- Test proving only the newest generated-UI step auto-expands.

The slice is complete when a replayed inline workflow displays its persisted step interface and a
later step still uses the durable data returned beside `$ui`.

### - [ ] Slice 7 — Make generated UI results efficient in agent context

**User-visible outcome:** large generated specs render in Backoffice without unnecessarily bloating
the model's next turn, and invalid specs give the agent enough feedback to repair them.

Refine the server-side `execCodeMode` result text while keeping full details for the client:

- Detect a structurally tagged `$ui` result at the codemode tool boundary.
- Preserve the complete raw value in tool `details.result`.
- For a valid generated UI, return compact model-facing text that acknowledges the rendered result
  and includes relevant non-UI fields without serializing the full spec.
- For an invalid generated UI, return concise validation feedback that identifies the repairable
  issue.
- Preserve existing text behavior for ordinary results, errors, and workflow scheduling handles.
- Avoid coupling the dynamic codemode Worker to React rendering code.
- Keep canonical validation in an isomorphic module that can run at the server trust boundary and
  the client presentation boundary.

Automated proof:

- Tool execution test proving the full `$ui` remains in `details.result`.
- Tool execution test proving valid generated UI produces compact model-facing text.
- Tool execution test proving invalid generated UI produces useful validation feedback.
- Regression tests for ordinary output, errors, logs, and inline workflow scheduling handles.

The slice is complete when generated specs no longer dominate tool-result text and the agent can
repair invalid UI from concise feedback.

### - [ ] Slice 8 — Harden the complete session experience

**User-visible outcome:** generated interfaces remain usable across long sessions, narrow layouts,
large data sets, workflow retries, and rendering failures.

Finish the integrated experience:

- Review generated UI against current Backoffice layout, typography, border, color, and motion
  conventions.
- Verify keyboard access for every disclosure and scroll region.
- Verify heading order, list semantics, table semantics, progress semantics, and readable status
  labels.
- Respect reduced-motion preferences.
- Keep generated UI responsive inside the session thread on narrow and wide layouts.
- Bound rendering work for large tables, lists, and deeply nested specs.
- Ensure session switching and tool-card unmounting clean up workflow polling.
- Ensure reconnecting session projections do not duplicate workflow requests or reset expanded
  results unexpectedly.
- Confirm generated UI remains read-only and cannot invoke unregistered actions.
- Remove obsolete codemode result formatting helpers made redundant by `ResultContent`.
- Keep unrelated Cadence code unchanged rather than migrating or deleting it as part of this work.

Automated proof:

- Accessibility-focused component tests.
- Narrow-width and overflow rendering tests for representative reports.
- Cleanup tests for session switching, unmounting, and polling cancellation.
- Regression test for reconnecting projection data with an already completed tool call.
- Focused session-detail test suite.
- Focused codemode Cloudflare test suite.
- Focused workflow persistence/history test suite.
- `cd apps/backoffice && pnpm run types:check`.
- `cd apps/backoffice && pnpm run build`.
- Affected Turborepo build, type-check, and test filters.
- `pnpm run format:changed`.

The slice is complete when the full behavior passes automated verification and manual checks for an
immediate result, a completed workflow result, a waiting workflow, an errored workflow, and a
workflow with multiple generated step results.

## Acceptance criteria

- Generated UI is implemented in the current Backoffice session detail surface and its supporting
  Backoffice modules.
- No Cadence component, prompt transcript, companion panel, or workflow workbench is reused.
- Plain codemode return values keep their existing text/JSON behavior.
- A valid top-level `$ui` sidecar renders safely inside the `execCodeMode` tool card.
- A malformed `$ui` sidecar cannot crash or blank the session thread.
- Inline workflow terminal outputs render through the same result presenter.
- Completed inline workflow step results render from persisted workflow history.
- Workflow result objects retain ordinary fields for downstream durable dataflow.
- Generated components follow current Backoffice colors, density, borders, typography, motion, and
  accessibility conventions.
- The catalog does not permit arbitrary HTML, styles, scripts, embeds, or network actions.
- The agent learns the contract from `generating-backoffice-uis`, not from new detailed
  system-prompt instructions.
- Runtime validation, React rendering, examples, and the agent skill share one canonical catalog.
- Every vertical slice has focused automated proof before the next slice begins.
