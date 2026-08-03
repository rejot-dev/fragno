import { backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import {
  jsonSchemaToTypeScript,
  type JsonSchemaObject,
  zodSchemaToJsonSchema,
} from "@/lib/zod/zod-formatter";

import type { FileContent } from "../interface";

type ConstrainedJsonSchema = JsonSchemaObject & {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function describeRange(minimum: number | undefined, maximum: number | undefined, unit: string) {
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum}-${maximum} ${unit}`;
  }
  if (minimum !== undefined) {
    return `at least ${minimum} ${unit}`;
  }
  if (maximum !== undefined) {
    return `at most ${maximum} ${unit}`;
  }
  return undefined;
}

function collectSchemaLimits(schema: JsonSchemaObject, path: string): string[] {
  const constrainedSchema = schema as ConstrainedJsonSchema;
  const limits = [
    describeRange(constrainedSchema.minLength, constrainedSchema.maxLength, "characters"),
    describeRange(constrainedSchema.minimum, constrainedSchema.maximum, "numeric value"),
    describeRange(constrainedSchema.minItems, constrainedSchema.maxItems, "items"),
  ].filter((limit): limit is string => Boolean(limit));
  const lines = limits.length > 0 ? [`${path}: ${limits.join(", ")}`] : [];

  for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
    lines.push(...collectSchemaLimits(propertySchema, `${path}.${propertyName}`));
  }

  if (schema.items && !Array.isArray(schema.items)) {
    lines.push(...collectSchemaLimits(schema.items, `${path}[]`));
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    lines.push(...collectSchemaLimits(schema.additionalProperties, `${path}.*`));
  }

  return lines;
}

export function renderComponentReference() {
  return Object.entries(backofficeUiComponentDefinitions)
    .map(([name, definition]) => {
      const propsSchema = zodSchemaToJsonSchema(definition.props, "input");
      if (!propsSchema) {
        throw new Error(`Expected ${name} to define a props schema.`);
      }

      const propsType = jsonSchemaToTypeScript(propsSchema);
      const propLimits = Object.entries(propsSchema.properties ?? {}).flatMap(
        ([propertyName, propertySchema]) => collectSchemaLimits(propertySchema, propertyName),
      );
      const limitsReference = propLimits.length
        ? `\n\nLimits:\n${propLimits.map((limit) => `- ${limit}`).join("\n")}`
        : "";
      const children = (definition.slots as readonly string[]).includes("default")
        ? "May contain child element ids."
        : "Must use an empty children array.";

      return `### \`${name}\`

${definition.description}

Props type:

\`\`\`ts
${propsType}
\`\`\`${limitsReference}

Children: ${children}

Example props:

\`\`\`json
${JSON.stringify(definition.example, null, 2)}
\`\`\``;
    })
    .join("\n\n");
}

const generatingBackofficeUisSkill = `---
name: generating-backoffice-uis
description: "Visualize Backoffice data in immediate codemode results, durable workflow steps, or final workflow output."
---

# Generating Backoffice UIs

## Steps

1. **Ground.** Read the relevant live provider declarations and capability skills before any required retrieval. Use retrieved, input, or persisted data already available to the current return path; retrieve only source data that is still missing. Represent unavailable information explicitly. Complete this step when every displayed operational value, record, status, and identifier traces to retrieved, input, or persisted output.
2. **Compose.** Derive the presentation from the grounded output, preserve source records and summaries needed by the user or later code beside \`$ui\`, and use the production catalog. Complete this step when every used component matches its exact props type and limits, every spec invariant holds, and every applicable workflow branch rule has been checked.
3. **Return.** Return one object matching the result contract and let the rendered interface carry the presentation. Complete this step when the object has its own \`$ui\` field with \`version: 1\`, every value consumed later remains an ordinary sibling field, and follow-up prose does not restate rendered fields.

## Result contract

The immediate result must have an own top-level \`$ui\` field with \`version: 1\`:

\`\`\`ts
type StateVisibilityCondition = {
  $state: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number | { $state: string };
  gte?: number | { $state: string };
  lt?: number | { $state: string };
  lte?: number | { $state: string };
  not?: true;
};

type VisibilityCondition =
  | boolean
  | StateVisibilityCondition
  | StateVisibilityCondition[]
  | { $and: VisibilityCondition[] }
  | { $or: VisibilityCondition[] };

type BackofficeUiResult = {
  [ordinaryField: string]: unknown;
  $ui: {
    version: 1;
    state: Record<string, unknown>;
    spec: {
      root: string;
      elements: Record<string, {
        type: CatalogComponentName;
        props: Record<string, unknown>;
        children: string[];
        visible?: VisibilityCondition;
      }>;
    };
  };
};
\`\`\`

Ordinary sibling fields remain part of the result. Preserve retrieved records, identifiers, and calculated summaries there when they remain useful to the user or later code.

## Durable workflow branch

When returning \`$ui\` from \`step.do\` or from a workflow's final output:

1. Read \`/static/skills/workflows/SKILL.md\` and satisfy its complete replay gate.
2. Read \`/static/skills/generating-backoffice-uis/WORKFLOWS.md\` for the UI-specific persistence, dataflow, and rendering contract.

Complete this branch only when both references have been applied.

## Spec invariants

The installed json-render shape is a flat element graph:

- \`root\` names an element in \`elements\`.
- Every child names an element in the same \`elements\` record.
- Every element contains exactly \`type\`, \`props\`, and \`children\`, plus optional \`visible\`; \`on\`, \`watch\`, \`repeat\`, arbitrary actions, event bindings, and other fields are invalid. Durable workflow input uses the catalog's narrowly scoped \`WorkflowEventButton\` component instead.
- Component and prop names are case-sensitive and must match the production catalog; unsupported names are invalid.
- Component props may use read expressions such as \`{ "$state": "/path" }\` at any depth, including inside array items and object fields. Use \`{ "$bindState": "/path" }\` only as the complete top-level value of an editable component's natural value prop so the renderer can expose its write-back binding.
- \`visible\` may be a boolean or a state visibility condition. A state condition uses exactly one of \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, or \`lte\`; omitting the comparison checks truthiness. \`not: true\` inverts it. Arrays and \`$and\` are AND; \`$or\` is OR.
- Every root and child reference resolves, and the child graph is acyclic.
- The graph stays within 128 elements, 32 children per element, 512 total child references, and 24 levels of depth.

## Immediate example

This example retrieves the live event catalog before deriving and presenting its metrics:

\`\`\`js
async () => {
  const eventCatalog = await events.catalogList({});
  const sourceCount = new Set(eventCatalog.map((event) => event.source)).size;
  const summary = {
    eventTypeCount: eventCatalog.length,
    sourceCount,
  };

  return {
    eventCatalog,
    summary,
    $ui: {
      version: 1,
      state: {
        eventTypeCount: String(summary.eventTypeCount),
        sourceCount: String(summary.sourceCount),
      },
      spec: {
        root: "report",
        elements: {
          report: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "description", "event-types", "sources"],
          },
          heading: {
            type: "Heading",
            props: { text: "Event catalog" },
            children: [],
          },
          description: {
            type: "Text",
            props: { text: "Live capabilities retrieved from Backoffice." },
            children: [],
          },
          "event-types": {
            type: "Metric",
            props: {
              label: "Event types",
              value: { $state: "/eventTypeCount" },
            },
            children: [],
          },
          sources: {
            type: "Metric",
            props: {
              label: "Sources",
              value: { $state: "/sourceCount" },
            },
            children: [],
          },
        },
      },
    },
  };
};
\`\`\`

## Durable workflow input

A completed \`step.do\` UI may collect input for a following \`step.waitForEvent\`:

- Put editable values in \`$ui.state\` and bind \`TextInput.value\`, \`TextArea.value\`, \`Select.value\`, or \`Checkbox.checked\` with \`{ "$bindState": "/path" }\`.
- Set \`TextInput.secret\` to \`true\` for sensitive values such as API keys so the browser masks the entered value.
- Add one \`WorkflowEventButton\`. Its \`eventType\` must exactly match the following \`waitForEvent\` type, and its complete \`payload\` should normally be \`{ "$state": "/response" }\`.
- Return the UI from a completed step before awaiting the event. The Backoffice supplies the current workflow name and instance ID; never place workflow identifiers or URLs in the generated interface.
- The button is enabled only while the displayed run is currently waiting for the declared event type. A stale or terminal interface remains visible but cannot submit again.

\`\`\`js
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
\`\`\`

## Production component catalog

This reference comes from the definitions used by runtime validation and rendering. Props are strict: use only the fields shown by each props type and satisfy every listed limit.

${renderComponentReference()}

## Presentation boundaries

- **Safe presentation:** render content through catalog props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary URLs, class names, styles, and presentation colors are invalid.
- **Primary answer:** let the rendered interface carry the presentation. A large Markdown table or other restatement is invalid.
`;

const generatingBackofficeUisWorkflowReference = `# Durable Workflow UI Results

This reference contains only the \`$ui\` behavior specific to durable workflow results.

## Result behavior

- A \`step.do\` callback may return the same \`BackofficeUiResult\` contract as an immediate codemode call. The complete serializable result is persisted, while its \`$ui\` interface renders inline in the matching completed step.
- Keep every identifier and value needed by later steps as an ordinary sibling field beside \`$ui\`.
- Consume later values from the resolved step result's ordinary fields. \`$ui.state\` is presentation state, not the workflow's durable dataflow API.
- Ordinary sibling fields remain durable data and are not presented as raw-result UI.
- Returning the same result from the workflow function renders it as the final output. The workflow workspace's \`UI\` mode shows only steps and final output containing \`$ui\`.
- For user input, return a generated interface from a completed \`step.do\`, then await \`step.waitForEvent\`. Bind form controls into \`$ui.state\` and submit that state through \`WorkflowEventButton\` with the exact awaited event type. Final workflow output is terminal and cannot accept workflow input.

## Example

\`\`\`js
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
\`\`\`
`;

export const GENERATING_BACKOFFICE_UIS_SKILL_CONTENT = {
  "skills/generating-backoffice-uis/SKILL.md": generatingBackofficeUisSkill,
  "skills/generating-backoffice-uis/WORKFLOWS.md": generatingBackofficeUisWorkflowReference,
} satisfies Record<string, FileContent>;
