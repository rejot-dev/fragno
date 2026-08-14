# Durable Workflow UI Results

Apply this reference together with `/static/skills/workflows/SKILL.md`.

## Result behavior

- A `step.do` callback may return the same `BackofficeUiResult` contract as an immediate codemode
  call. The complete serializable result is persisted, while its `$ui` interface renders inline in
  the matching completed step.
- Keep every identifier and value needed by later steps as an ordinary sibling field beside `$ui`.
- Consume later values from the resolved step result's ordinary fields. `$ui.state` is presentation
  state, not the workflow's durable dataflow API.
- Returning the same result from the workflow function renders it as the final output. When the
  return directly delegates to that UI step, the Backoffice keeps the UI on the step instead of
  rendering a duplicate final-output card.
- Final workflow output is terminal and cannot collect workflow input.

## Collecting workflow input

1. Return a generated interface from a completed `step.do`.
2. Put editable values under one response object in `$ui.state` and bind each control's natural
   value prop with `$bindState`.
3. Add one `WorkflowEventButton`. Its `eventType` exactly matches the following `step.waitForEvent`
   type, and its payload is the complete response object.
4. Await the event after the completed UI step. The Backoffice supplies the workflow name and
   instance id to the renderer.

Complete this branch when the interface submits every requested field through one exact event type
and the workflow consumes the submitted payload from `waitForEvent`.

```js
await step.do("request approval", async () => ({
  $ui: {
    version: 1,
    state: { response: { decision: "approve", reason: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["decision", "reason", "submit"],
        },
        decision: {
          type: "Select",
          props: {
            label: "Decision",
            value: { $bindState: "/response/decision" },
            options: [
              { label: "Approve", value: "approve" },
              { label: "Reject", value: "reject" },
            ],
          },
          children: [],
        },
        reason: {
          type: "TextArea",
          props: { label: "Reason", value: { $bindState: "/response/reason" } },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Submit decision",
            eventType: "approval",
            payload: { $state: "/response" },
          },
          children: [],
        },
      },
    },
  },
}));

const approval = await step.waitForEvent("approval", { type: "approval" });
```

## Durable dataflow example

```js
const report = await step.do("build order report", async () => {
  const orders = await ordersApi.list({ status: "open" });

  return {
    orderIds: orders.map((order) => order.id),
    orderCount: orders.length,
    $ui: {
      version: 1,
      state: { orderCount: String(orders.length) },
      spec: {
        root: "metric",
        elements: {
          metric: {
            type: "Metric",
            props: { label: "Open orders", value: { $state: "/orderCount" } },
            children: [],
          },
        },
      },
    },
  };
});

await step.do("process reported orders", async () => {
  return await processOrders(report.orderIds);
});

return report;
```
