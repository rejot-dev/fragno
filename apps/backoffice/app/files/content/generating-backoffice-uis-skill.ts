import { backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import { formatJsonSchemaFields, zodSchemaToJsonSchema } from "@/lib/zod/zod-formatter";

import type { FileContent } from "../interface";

export function renderComponentReference() {
  return Object.entries(backofficeUiComponentDefinitions)
    .map(([name, definition]) => {
      const props = formatJsonSchemaFields(zodSchemaToJsonSchema(definition.props, "input"));
      const children = (definition.slots as readonly string[]).includes("default")
        ? "May contain child element ids."
        : "Must use an empty children array.";

      return `### \`${name}\`

${definition.description}

Props:

\`\`\`text
${props}
\`\`\`

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
description: "Visualize retrieved Backoffice data as dashboards, reports, tables, metrics, or visual summaries."
---

# Generating Backoffice UIs

Produce one immediate, grounded visual result from an \`async () => ...\` codemode call.

## Steps

1. **Ground.** Read the relevant live provider declarations and capability skills, then retrieve the Backoffice data. Represent missing information explicitly as unavailable. Complete this step when every operational value, record, status, and identifier planned for display traces to retrieved output; fabricated values and placeholder records fail this criterion.
2. **Compose.** Derive the presentation from that output, preserve useful source records and summaries beside \`$ui\`, and use the production catalog. Complete this step when every spec invariant and component contract below passes a self-check.
3. **Return.** Return one object matching the result contract and treat the rendered interface as the primary answer. Complete this step when \`$ui\` is valid, useful ordinary fields remain available to later code, and follow-up prose adds only conclusions that the interface cannot show clearly.

## Result contract

The immediate result must have an own top-level \`$ui\` field with \`version: 1\`:

\`\`\`ts
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
        visible?: boolean | VisibilityCondition;
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
- Every element contains exactly \`type\`, \`props\`, and \`children\`, plus optional \`visible\`; \`on\`, \`watch\`, \`repeat\`, actions, event bindings, and other fields are invalid.
- Component and prop names are case-sensitive and must match the production catalog; unsupported names are invalid.
- A prop may use \`{ "$state": "/path" }\` to read a value from \`$ui.state\`.
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

## Production component catalog

This reference comes from the definitions used by runtime validation and rendering.

${renderComponentReference()}

## Presentation boundaries

- **Safe presentation:** render content through catalog props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary URLs, class names, styles, and presentation colors are invalid.
- **Primary answer:** let the rendered interface carry the presentation. A large Markdown table or other restatement is invalid.
`;

export const GENERATING_BACKOFFICE_UIS_SKILL_CONTENT = {
  "skills/generating-backoffice-uis/SKILL.md": generatingBackofficeUisSkill,
} satisfies Record<string, FileContent>;
