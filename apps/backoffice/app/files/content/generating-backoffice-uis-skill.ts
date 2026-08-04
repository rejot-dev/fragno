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
description: "Generate Backoffice interfaces for presenting grounded data or collecting durable workflow input."
---

# Generating Backoffice UIs

## Steps

1. **Ground.** Resolve the source data used by the interface. Use input, retrieved data, or persisted output already available to the current return path. Complete when every displayed operational value, record, status, and identifier traces to one of those sources.
2. **Compose.** Read \`/static/skills/generating-backoffice-uis/CATALOG.md\`, then derive a flat element graph from the grounded result. Complete when every component and prop matches the catalog and every spec invariant passes.
3. **Return.** Return one result object with \`$ui\` beside any ordinary fields needed by the user or later code. Complete when \`$ui.version\` is \`1\`, later code consumes ordinary fields rather than \`$ui.state\`, and follow-up prose does not restate rendered fields.

## Branches

- When returning \`$ui\` from \`step.do\` or as workflow output, read \`/static/skills/workflows/SKILL.md\` and \`/static/skills/generating-backoffice-uis/WORKFLOWS.md\` before authoring the workflow.
- When the interface contains \`FileUpload\`, read \`/static/skills/using-prepared-uploads/SKILL.md\` before composing it.

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

## Spec invariants

The installed json-render shape is a flat element graph:

- \`root\` names an element in \`elements\`.
- Every child names an element in the same \`elements\` record.
- Every element contains exactly \`type\`, \`props\`, and \`children\`, plus optional \`visible\`.
- Component and prop names are case-sensitive and match the production catalog.
- Component props may use read expressions such as \`{ "$state": "/path" }\` at any depth, including inside array items and object fields.
- Use \`{ "$bindState": "/path" }\` only as the complete top-level value of an editable component's natural value prop.
- \`visible\` may be a boolean or a state visibility condition. A state condition uses exactly one of \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, or \`lte\`; omitting the comparison checks truthiness. \`not: true\` inverts it. Arrays and \`$and\` are AND; \`$or\` is OR.
- Every root and child reference resolves, and the child graph is acyclic.
- The graph stays within 128 elements, 32 children per element, 512 total child references, and 24 levels of depth.

## Immediate example

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

## Presentation boundaries

Render content through catalog props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary URLs, class names, styles, and presentation colors are invalid. Let the rendered interface carry the primary presentation rather than repeating it in Markdown.
`;

const generatingBackofficeUisCatalogReference = `# Production Component Catalog

This reference is generated from the definitions used by runtime validation and rendering. Props are strict: use only the fields shown by each props type and satisfy every listed limit.

${renderComponentReference()}
`;

const generatingBackofficeUisWorkflowReference = `# Durable Workflow UI Results

Apply this reference together with \`/static/skills/workflows/SKILL.md\`.

## Result behavior

- A \`step.do\` callback may return the same \`BackofficeUiResult\` contract as an immediate codemode call. The complete serializable result is persisted, while its \`$ui\` interface renders inline in the matching completed step.
- Keep every identifier and value needed by later steps as an ordinary sibling field beside \`$ui\`.
- Consume later values from the resolved step result's ordinary fields. \`$ui.state\` is presentation state, not the workflow's durable dataflow API.
- Returning the same result from the workflow function renders it as the final output.
- Final workflow output is terminal and cannot collect workflow input.

## Collecting workflow input

1. Return a generated interface from a completed \`step.do\`.
2. Put editable values under one response object in \`$ui.state\` and bind each control's natural value prop with \`$bindState\`.
3. Add one \`WorkflowEventButton\`. Its \`eventType\` exactly matches the following \`step.waitForEvent\` type, and its payload is the complete response object.
4. Await the event after the completed UI step. The Backoffice supplies the workflow name and instance id to the renderer.

Complete this branch when the interface submits every requested field through one exact event type and the workflow consumes the submitted payload from \`waitForEvent\`.

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

## Durable dataflow example

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
  "skills/generating-backoffice-uis/CATALOG.md": generatingBackofficeUisCatalogReference,
  "skills/generating-backoffice-uis/WORKFLOWS.md": generatingBackofficeUisWorkflowReference,
} satisfies Record<string, FileContent>;
