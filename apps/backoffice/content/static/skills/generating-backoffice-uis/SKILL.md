---
name: generating-backoffice-uis
description:
  "Generate Backoffice interfaces for presenting grounded data or collecting durable workflow input."
---

# Generating Backoffice UIs

## Steps

1. **Ground.** Resolve the source data used by the interface. Use input, retrieved data, or
   persisted output already available to the current return path. Complete when every displayed
   operational value, record, status, and identifier traces to one of those sources.
2. **Compose.** Read `/static/codemode/ui.d.ts` and the components in
   `/static/codemode/ui-catalog.d.ts`, then build one element tree with the codemode `ui` builder,
   passing grounded values directly as props. Complete when every component call and prop matches
   its declaration and documented limits.
3. **Return.** Return one result object with `$ui: ui.render(root)` beside any ordinary fields
   needed by the user or later code. Complete when the tool result reports no generated UI error,
   later code consumes ordinary fields, and follow-up prose does not restate rendered fields.

## Branches

- When returning `$ui` from `step.do` or as workflow output, read
  `/static/skills/workflows/SKILL.md` before authoring the workflow, then apply **Durable results**.
- When the interface collects input, apply **Collecting workflow input**.
- When the interface contains `ui.fileUpload`, set its `scope` to `{ kind: "current" }` unless the
  file belongs to another declared scope, and start its field at `null`. Uploading writes the file
  into that scope's workspace; the submitted field holds its `scope`, `/workspace` `path`,
  `filename`, `sizeBytes`, and `contentType`. Read the file from `path` with the `state` tools of
  that scope, and remove it with `state.rm` when the workflow rejects it.
- When a tool result or step error reports an invalid generated UI, fix the element its id names.
  Ids are tree positions: `root.1.0` is the first child of the root's second child.

## Results

Ordinary sibling fields remain part of the result. Preserve retrieved records, identifiers, and
calculated summaries there when they remain useful to the user or later code; `$ui.state` is
presentation state, not a dataflow API. A rendered interface stays within 128 elements, 32 children
per element, and 24 levels of depth.

```js
async () => {
  const eventCatalog = await events.catalogList();
  const sourceCount = new Set(eventCatalog.map((event) => event.source)).size;

  return {
    eventCatalog,
    summary: { eventTypeCount: eventCatalog.length, sourceCount },
    $ui: ui.render(
      ui.stack({ gap: "md" }, [
        ui.heading({ text: "Event catalog" }),
        ui.text({ text: "Live capabilities retrieved from Backoffice." }),
        ui.grid({ columns: 2, gap: "md" }, [
          ui.metric({ label: "Event types", value: String(eventCatalog.length) }),
          ui.metric({ label: "Sources", value: String(sourceCount) }),
        ]),
      ]),
    ),
  };
};
```

## Durable results

- A `step.do` callback returns the same result shape as an immediate call. The complete result is
  persisted, and its `$ui` renders inline in the completed step. A step that returns an invalid
  `$ui` fails without retrying.
- Later steps consume the resolved step result's ordinary fields.
- Returning the same result from the workflow function renders it as the final output. When the
  return directly delegates to that UI step, the Backoffice keeps the UI on the step instead of
  rendering a duplicate final-output card.
- Final workflow output is terminal and cannot collect workflow input.

## Collecting workflow input

1. Declare `const form = ui.form(eventType, initial)` in the workflow body. `initial` names every
   field with its starting value.
2. Return the interface from a completed `step.do`. Bind each control's value prop with
   `form.bind(field)` and add one `form.submit({ label })`, which sends every field as the payload.
3. Await `step.waitForEvent(name, { type: form.eventType })` after the UI step. The Backoffice
   supplies the workflow name and instance id to the renderer.

Complete when every requested field is bound to the form and the workflow consumes the submitted
payload from `waitForEvent`.

```js
const approval = ui.form("approval", { decision: "approve", reason: "" });

await step.do("request approval", async () => ({
  $ui: ui.render(
    ui.stack({ gap: "md" }, [
      ui.select({
        label: "Decision",
        value: approval.bind("decision"),
        options: [
          { label: "Approve", value: "approve" },
          { label: "Reject", value: "reject" },
        ],
      }),
      ui.when(
        approval.is("decision", { eq: "reject" }),
        ui.textArea({ label: "Reason", value: approval.bind("reason") }),
      ),
      approval.submit({ label: "Submit decision" }),
    ]),
  ),
}));

const { payload } = await step.waitForEvent("approval", { type: approval.eventType });
```

## Presentation boundaries

Render content through component props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary
URLs, class names, styles, and presentation colors are invalid. Let the rendered interface carry the
primary presentation rather than repeating it in Markdown.

An inline workflow shows in the conversation as one card holding its status, every interface its
steps return, and its final output. Do not narrate the card: skip instructions for filling in its
form, which go stale once the reader submits it, and do not repeat its output when the
`instance.completed` event arrives. Reply to that event only with what the card does not show.
