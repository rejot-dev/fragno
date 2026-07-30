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
- Slices 1 and 2 establish safe generated-UI rendering inside the existing `execCodeMode` tool
  result card; Slice 5 moves the full rendered interface into a Backoffice-native tabbed session
  workspace on the right.
- The tool card remains the source/debug surface and can select or reopen its corresponding
  workspace tab. A generated specification must not be rendered in both places at once.
- Workflow graphs are derived automatically from streamed `execCodeMode` source as soon as an actual
  `defineWorkflow(...)` construction is recognized. They are not agent-authored `$ui`, are not
  selected by the agent, and do not add a workflow variant to the result contract.
- Inline workflow status, final output, and step results render in the automatically constructed
  workflow tab once the later workflow slices are implemented.
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

### - [x] Slice 5 — Add a tabbed session workspace for generated UI and constructing workflows

**User-visible outcome:** a normal Backoffice session opens a right-side workspace as soon as it has
something visual to show. Valid generated interfaces from multiple `execCodeMode` calls appear as
separate tabs. When streamed codemode source starts constructing a real `defineWorkflow(...)`, a
workflow graph tab appears and updates while the tool call is still being authored.

Add a route-local, Backoffice-native workspace under the current session detail surface:

```text
apps/backoffice/app/routes/backoffice/sessions/session-detail/
  workspace-model.ts
  workspace-panel.tsx
  workspace-split.tsx
  workspace-projection.ts
  workflow-graph-projection.ts
```

The exact file split may stay smaller, but preserve these boundaries:

- Project workspace content from persisted session messages and the current draft agent/tool state.
  Do not rely on mounted tool cards registering themselves through effects; workspace discovery must
  still work when tool calls are hidden, the session is restored, or the transcript is virtualized.
- Project one generated-interface tab for every completed `execCodeMode` call whose top-level result
  passes `parseBackofficeUiResult`. Key it by tool-call id, preserve first-appearance order, and
  deduplicate projection refreshes.
- Keep malformed tagged `$ui` results in their existing tool-card failure presentation. They do not
  create a workspace tab.
- Independently inspect streaming and completed `execCodeMode` source for an actual
  `defineWorkflow(...)` call expression. Do not trigger on comments, strings, ordinary identifiers,
  function or method declarations, or an agent-authored result field.
- Create the workflow graph tab automatically from source, keyed by its originating tool-call id.
  There is no `kind: "workflow"` result, no workflow `$ui` sidecar, and no agent action that chooses
  whether the tab exists.
- Enter a compact constructing state as soon as a tolerant source parser recognizes the call being
  built. Incrementally replace it with the latest valid graph projection as source arrives; retain
  the last valid graph across temporarily incomplete syntax instead of flashing parse errors.
- Keep generated-UI projection and workflow-source projection as separate pure modules. The session
  workspace combines their ordered tabs but does not blur their trust boundaries.
- If one codemode call both constructs a workflow and later returns a generated interface, expose
  both tabs and keep both associated with the same tool-call id through distinct stable tab ids.

Build the session layout and interaction:

- Keep `SessionHeader` above the workspace. Place the existing `SessionThread` on the left and the
  workspace on the right in a resizable split at wide widths, with a Backoffice-native
  drawer/overlay treatment at narrow widths. Bound the sessions surface to the available viewport so
  long conversations cannot increase the workspace height; chat and workspace content must scroll
  independently without chaining into the page.
- On narrow widths, keep a persistent tab rail above the content with `Chat` first followed by every
  projected interface or workflow. Selecting `Chat` closes the drawer without unmounting the thread.
- Give the workspace a subtle transform-and-opacity entrance animation every time it mounts,
  including after a manual close followed by `Open workflow graph`. On desktop, also animate the
  conversation width into the split. Keep these workspace effects enabled even when the operating
  system requests reduced motion so opening remains visibly verifiable.
- Keep the session thread mounted in the same React position while the workspace opens, closes, or
  switches tabs so message state, composer state, scroll position, and subscriptions survive.
- Use current `--bo-*` variables, square-edged bordered surfaces, compact uppercase tab labels, and
  `backoffice-scroll`. Do not import Cadence's split, companion panel, prompt context, transcript,
  workflow workbench, or Cadence visual tokens.
- Render workflow tabs through the canonical automation graph at
  `apps/backoffice/app/routes/backoffice/automations/script-view/workflow-graph.tsx`. Reuse the
  scripts view's `Simple`/`Verbose` and `Code`/`Graph`/`Both` controls and source viewer so a
  session workflow can switch presentation without creating a second graph renderer or using XYFlow.
- Render generated-interface tabs through the existing production parser, renderer, state provider,
  and local error boundary. Do not introduce a second generated-UI validation path.
- Move the full valid `$ui` rendering out of the tool card. Keep raw/debug disclosures and a compact
  `Open interface` action in the originating card so the same spec is never rendered twice.
- Auto-open and select the latest available tab when entering a session that already contains visual
  output. While the session remains mounted, retain the cumulative set of observed tab ids, respect
  a manual close across ordinary or temporarily incomplete projection refreshes, and reopen only
  when a genuinely new tab first appears. Reconciliation must preserve state identity when no
  semantic field changes so unstable projection arrays cannot create an effect-driven render loop.
- Select newly discovered tabs automatically, preserve explicit tab selection across content
  updates, and reset workspace state when the session id or workflow name changes.
- Give every tab proper tab/list/panel semantics, keyboard navigation, visible focus, an accessible
  close action, and a stable fallback label derived by Backoffice rather than requiring new `$ui`
  contract fields.

Automated proof:

- Pure projection tests for multiple generated interfaces, chronological ordering, stable ids,
  deduplication, invalid tagged results, persisted history, and draft-tool updates.
- Workflow-source tests proving actual `defineWorkflow(...)` construction creates a tab while
  comments, strings, similarly named identifiers, and non-call declarations do not.
- Incremental graph tests proving incomplete streamed source enters constructing state, later valid
  source updates the graph, and a temporary invalid edit retains the last valid projection.
- Workspace state tests for initial auto-open, newly discovered tabs, manual close, explicit tab
  selection, temporary projection gaps, unchanged-state identity, and session changes.
- Rendering tests proving a generated interface appears in the selected workspace tab, its tool card
  can reopen/select it, and the full specification is not rendered twice.
- Workflow presentation tests proving `Simple`/`Verbose` and `Code`/`Graph`/`Both` switch the
  selected session workflow between the shared source and graph views.
- Client test proving the thread and composer are not remounted when the workspace toggles.
- Layout tests proving long chat content cannot grow the sessions surface and that conversation,
  generated-interface, source, and graph panes own their scrolling independently.
- Accessibility tests for desktop tabs, the small-screen `Chat` tab, panels, the resize separator,
  drawer close behavior, and keyboard navigation.
- Dependency-boundary test proving the new session workspace imports the automation script graph and
  does not import Cadence components or XYFlow.

The slice is complete when a live normal session can show multiple codemode-generated interfaces in
stable tabs, can open a workflow graph before the defining `execCodeMode` call finishes, and can
close/reopen the workspace without disturbing the conversation.

### - [ ] Slice 6 — Render an inline workflow's terminal UI result

**User-visible outcome:** an inline `defineWorkflow` started by `execCodeMode` remains attached to
its automatically constructed workflow tab, shows live status there, and renders its final `$ui`
output when complete.

Use the run handle already returned in `completedToolResult.details.run`:

- Define and validate the `{ workflowName, instanceId }` run-handle shape.
- Attach the run handle to the existing source-derived workflow tab for that tool-call id. The run
  handle enriches the tab; it does not decide whether the workflow tab exists.
- Add a session-detail-specific workflow hook, for example in `workflow-result.tsx` or a nearby
  module.
- Use the active organisation/scope from the sessions route context to construct workflow requests.
- Pass the required scope information from `session-detail.tsx` into the workspace without creating
  hidden globals.
- Load workflow instance status while its session workspace is mounted and refresh it when the tab
  is reopened.
- Poll while the instance is active, waiting, or paused.
- Stop on complete, errored, or terminated status.
- Abort requests when the workspace unmounts or the session changes.
- Treat temporary request failures as retryable presentation state rather than changing the original
  tool call to failed.
- Render compact Backoffice workflow status alongside the graph in the workflow tab.
- Read the terminal output from the instance status response.
- Pass terminal output through the same `ResultContent` used for immediate results.
- Render ordinary final values as text/JSON and `$ui` final values through json-render inside the
  workflow tab.
- Keep the original tool card as the source/debug surface with an action that selects its workflow
  tab.
- Do not present the initial run handle as the workflow's final result.
- Do not reuse Cadence workflow panels or workbench components.

Automated proof:

- Run-handle parser tests.
- Tests proving a run handle attaches to, rather than creates, the source-derived workflow tab.
- Hook tests for active polling, terminal shutdown, unmount abort, reopen refresh, and transient
  request errors.
- Workspace rendering tests for active, waiting, completed, errored, and terminated status.
- Workflow integration test proving a terminal `$ui` result survives status serialization.
- Rendering test proving the terminal `$ui` result uses the same production presenter as an
  immediate result.

The slice is complete when a live inline workflow can finish and render its final interface in the
same workflow tab that appeared while its source was being constructed.

### - [ ] Slice 7 — Render durable UI results from inline workflow steps

**User-visible outcome:** users can inspect generated interfaces returned by individual `step.do`
operations in the workflow workspace tab while retaining graph context, status, attempts, and
errors.

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
- Connect persisted step state to the existing source-derived graph without making graph existence
  depend on history or run status.
- Render steps as compact bordered Backoffice rows in the workflow workspace tab.
- Show waiting, retrying, errored, and completed states in both graph status and readable step rows.
- Add an expandable result region for completed steps with non-null results.
- Pass each step result through the shared `ResultContent` component.
- Auto-expand the newest completed step whose result contains valid `$ui`.
- Keep older step results collapsed so long workflows do not overwhelm the workspace.
- Preserve attempt and error details for debugging.
- Confirm `$ui` values are replay-safe plain data and round-trip unchanged through step persistence.
- Confirm downstream workflow code can still consume non-UI fields from the same result object.

Automated proof:

- History projection tests for ordering, nesting, attempts, errors, and results.
- Workflow harness test in which a `step.do` returns ordinary data plus `$ui`.
- Assertion that persisted history contains the unchanged `$ui` value after replay.
- Assertion that a later step consumes a non-UI field from the same persisted result.
- Workspace rendering test for a workflow containing ordinary, generated-UI, waiting, and errored
  step results.
- Test proving only the newest generated-UI step auto-expands.
- Test proving history refreshes update graph status without replacing or duplicating the workflow
  tab.

The slice is complete when a replayed inline workflow displays its persisted step interface in its
workflow tab and a later step still uses the durable data returned beside `$ui`.

### - [ ] Slice 8 — Make generated UI results efficient in agent context

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

### - [ ] Slice 9 — Harden the complete session experience

**User-visible outcome:** generated interfaces remain usable across long sessions, narrow layouts,
large data sets, workflow retries, and rendering failures.

Finish the integrated experience:

- Review generated UI against current Backoffice layout, typography, border, color, and motion
  conventions.
- Verify keyboard access for every disclosure and scroll region.
- Verify heading order, list semantics, table semantics, progress semantics, and readable status
  labels.
- Respect reduced-motion preferences.
- Keep generated UI responsive inside the session workspace on narrow and wide layouts.
- Bound rendering work for large tables, lists, and deeply nested specs.
- Ensure session switching and workspace unmounting clean up workflow polling.
- Ensure reconnecting session projections do not duplicate tabs or workflow requests, reopen a
  manually closed workspace, or reset the selected tab unexpectedly.
- Confirm generated UI remains read-only and cannot invoke unregistered actions.
- Remove obsolete codemode result formatting helpers made redundant by `ResultContent`.
- Keep unrelated Cadence code unchanged rather than migrating or deleting it as part of this work.

Automated proof:

- Accessibility-focused component tests.
- Narrow-width, drawer, resize, and overflow rendering tests for representative reports.
- Cleanup tests for session switching, workspace unmounting, and polling cancellation.
- Regression test for reconnecting projection data with already completed UI and workflow tabs.
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
- No Cadence component, prompt transcript, companion panel, workflow workbench, or visual token is
  reused; the session workspace is Backoffice-native.
- Plain codemode return values keep their existing text/JSON behavior.
- A valid top-level `$ui` sidecar renders safely in a right-side tabbed session workspace, and its
  originating `execCodeMode` tool card can select or reopen that tab.
- Multiple codemode-generated interfaces retain stable, ordered tabs across session projection
  refreshes.
- A malformed `$ui` sidecar cannot crash or blank the session thread or workspace.
- An actual streamed `defineWorkflow(...)` construction creates and incrementally updates a workflow
  graph tab without requiring an agent-authored result discriminator or sidecar.
- Inline workflow terminal outputs render through the same result presenter in that workflow tab.
- Completed inline workflow step results render from persisted workflow history in that workflow
  tab.
- Workflow result objects retain ordinary fields for downstream durable dataflow.
- Generated components follow current Backoffice colors, density, borders, typography, motion, and
  accessibility conventions.
- The catalog does not permit arbitrary HTML, styles, scripts, embeds, or network actions.
- The agent learns the contract from `generating-backoffice-uis`, not from new detailed
  system-prompt instructions.
- Runtime validation, React rendering, examples, and the agent skill share one canonical catalog.
- Opening, closing, resizing, or switching the session workspace does not remount the conversation
  thread.
- Every vertical slice has focused automated proof before the next slice begins.
