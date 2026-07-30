import { assert, describe, expect, test } from "vitest";

import { backofficeUiCatalog, backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import type { FileContent } from "../interface";
import {
  GENERATING_BACKOFFICE_UIS_SKILL_CONTENT,
  renderComponentReference,
} from "./generating-backoffice-uis-skill";
import { STATIC_FILE_CONTENT } from "./static";

const staticContent = STATIC_FILE_CONTENT as Record<string, FileContent>;
const skill = GENERATING_BACKOFFICE_UIS_SKILL_CONTENT["skills/generating-backoffice-uis/SKILL.md"];

if (typeof skill !== "string") {
  throw new Error("Expected the generated Backoffice UI skill to contain text.");
}

type EventCatalogEntry = {
  source: string;
  eventType: string;
  label: string;
  capabilityId: string;
};

const readImmediateExample = () => {
  const match = /## Immediate example[\s\S]*?```js\n(?<example>[\s\S]*?)\n```/u.exec(skill);
  const example = match?.groups?.example;
  if (!example) {
    throw new Error("Expected the skill to contain an immediate JavaScript example.");
  }
  return example;
};

const createImmediateExample = async (events: {
  catalogList: (input: Record<string, never>) => Promise<EventCatalogEntry[]>;
}) => {
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

describe("generating Backoffice UIs skill", () => {
  test("renders the production skill", () => {
    expect(skill).toMatchInlineSnapshot(`
      "---
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

      ### \`Stack\`

      Arranges generated Backoffice content vertically with a controlled gap.

      Props:

      \`\`\`text
        gap  "sm" | "md" | "lg"  required
      \`\`\`

      Children: May contain child element ids.

      Example props:

      \`\`\`json
      {
        "gap": "md"
      }
      \`\`\`

      ### \`Heading\`

      Displays a compact section heading.

      Props:

      \`\`\`text
        text  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "text": "Order summary"
      }
      \`\`\`

      ### \`Text\`

      Displays supporting body text.

      Props:

      \`\`\`text
        text  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "text": "Orders processed during the current period."
      }
      \`\`\`

      ### \`Metric\`

      Displays one labeled operational metric.

      Props:

      \`\`\`text
        label  string  required
        value  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "label": "Orders",
        "value": "24"
      }
      \`\`\`

      ## Presentation boundaries

      - **Safe presentation:** render content through catalog props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary URLs, class names, styles, and presentation colors are invalid.
      - **Primary answer:** let the rendered interface carry the presentation. A large Markdown table or other restatement is invalid.
      "
    `);
  });

  test("renders the canonical component reference", () => {
    expect({
      componentNames: Object.keys(backofficeUiComponentDefinitions),
      reference: renderComponentReference(),
    }).toMatchInlineSnapshot(`
      {
        "componentNames": [
          "Stack",
          "Heading",
          "Text",
          "Metric",
        ],
        "reference": "### \`Stack\`

      Arranges generated Backoffice content vertically with a controlled gap.

      Props:

      \`\`\`text
        gap  "sm" | "md" | "lg"  required
      \`\`\`

      Children: May contain child element ids.

      Example props:

      \`\`\`json
      {
        "gap": "md"
      }
      \`\`\`

      ### \`Heading\`

      Displays a compact section heading.

      Props:

      \`\`\`text
        text  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "text": "Order summary"
      }
      \`\`\`

      ### \`Text\`

      Displays supporting body text.

      Props:

      \`\`\`text
        text  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "text": "Orders processed during the current period."
      }
      \`\`\`

      ### \`Metric\`

      Displays one labeled operational metric.

      Props:

      \`\`\`text
        label  string  required
        value  string  required
      \`\`\`

      Children: Must use an empty children array.

      Example props:

      \`\`\`json
      {
        "label": "Orders",
        "value": "24"
      }
      \`\`\`",
      }
    `);
  });

  test("ships an immediate example accepted by the production result boundary", async () => {
    const immediateExampleCode = readImmediateExample();
    assert(immediateExampleCode.includes("$ui"));

    const result = await createImmediateExample({
      catalogList: async () => [
        {
          source: "telegram",
          eventType: "message.received",
          label: "Telegram message received",
          capabilityId: "telegram",
        },
        {
          source: "github",
          eventType: "pull_request.opened",
          label: "Pull request opened",
          capabilityId: "github",
        },
      ],
    });

    const parsedResult = parseBackofficeUiResult(result);

    if (parsedResult.kind !== "valid") {
      throw new Error(`Expected a valid generated UI, received ${parsedResult.kind}.`);
    }

    expect({
      catalogValid: backofficeUiCatalog.validate(parsedResult.value.$ui.spec).success,
      result: parsedResult.value,
    }).toMatchInlineSnapshot(`
      {
        "catalogValid": true,
        "result": {
          "$ui": {
            "spec": {
              "elements": {
                "description": {
                  "children": [],
                  "props": {
                    "text": "Live capabilities retrieved from Backoffice.",
                  },
                  "type": "Text",
                },
                "event-types": {
                  "children": [],
                  "props": {
                    "label": "Event types",
                    "value": {
                      "$state": "/eventTypeCount",
                    },
                  },
                  "type": "Metric",
                },
                "heading": {
                  "children": [],
                  "props": {
                    "text": "Event catalog",
                  },
                  "type": "Heading",
                },
                "report": {
                  "children": [
                    "heading",
                    "description",
                    "event-types",
                    "sources",
                  ],
                  "props": {
                    "gap": "md",
                  },
                  "type": "Stack",
                },
                "sources": {
                  "children": [],
                  "props": {
                    "label": "Sources",
                    "value": {
                      "$state": "/sourceCount",
                    },
                  },
                  "type": "Metric",
                },
              },
              "root": "report",
            },
            "state": {
              "eventTypeCount": "2",
              "sourceCount": "2",
            },
            "version": 1,
          },
          "eventCatalog": [
            {
              "capabilityId": "telegram",
              "eventType": "message.received",
              "label": "Telegram message received",
              "source": "telegram",
            },
            {
              "capabilityId": "github",
              "eventType": "pull_request.opened",
              "label": "Pull request opened",
              "source": "github",
            },
          ],
          "summary": {
            "eventTypeCount": 2,
            "sourceCount": 2,
          },
        },
      }
    `);
  });

  test("keeps detailed UI authoring guidance out of the static system prompt", () => {
    const systemGuidance = staticContent["SYSTEM.md"];
    if (typeof systemGuidance !== "string") {
      throw new Error("Expected static system guidance to contain text.");
    }

    expect({
      containsBackofficeUiResult: systemGuidance?.includes("BackofficeUiResult"),
      containsGeneratedCatalog: systemGuidance?.includes("Production component catalog"),
      containsUiEnvelope: systemGuidance?.includes("$ui"),
    }).toMatchInlineSnapshot(`
      {
        "containsBackofficeUiResult": false,
        "containsGeneratedCatalog": false,
        "containsUiEnvelope": false,
      }
    `);
  });
});
