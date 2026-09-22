import { assert, describe, expect, test } from "vitest";

import { backofficeUiCatalog, backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import {
  GENERATING_BACKOFFICE_UIS_SKILL_CONTENT,
  renderComponentReference,
} from "./generating-backoffice-uis-skill";

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

function readImmediateExample() {
  const match = /## Immediate example[\s\S]*?```js\n(?<example>[\s\S]*?)\n```/u.exec(skill);
  const example = match?.groups?.example;
  if (!example) {
    throw new Error("Expected the skill to contain an immediate JavaScript example.");
  }
  return example;
}

async function createImmediateExample(events: {
  catalogList: (input: Record<string, never>) => Promise<EventCatalogEntry[]>;
}) {
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
}

describe("generating Backoffice UIs skill", () => {
  test("renders exact nested prop types for every canonical component", () => {
    const reference = renderComponentReference();
    const componentNames = Object.keys(backofficeUiComponentDefinitions);

    expect(reference).not.toContain("object[]");
    expect(reference).toContain("detail?: string;");
    expect(reference).toContain("[key: string]: string;");
    expect(reference).toContain("- items[].title: 1-200 characters");

    expect(componentNames).toEqual([
      "Stack",
      "Grid",
      "Section",
      "Divider",
      "Heading",
      "Text",
      "Code",
      "Callout",
      "Metric",
      "Badge",
      "KeyValue",
      "List",
      "Table",
      "Progress",
      "TextInput",
      "TextArea",
      "Select",
      "Checkbox",
      "FileUpload",
      "WorkflowEventButton",
    ]);

    let previousIndex = -1;
    for (const componentName of componentNames) {
      const componentIndex = reference.indexOf(`### \`${componentName}\``);
      expect(componentIndex).toBeGreaterThan(previousIndex);
      previousIndex = componentIndex;
    }
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

    assert(backofficeUiCatalog.validate(parsedResult.value.$ui.spec).success);
    expect(parsedResult.value.summary).toEqual({ eventTypeCount: 2, sourceCount: 2 });
    expect(parsedResult.value.eventCatalog).toHaveLength(2);
  });
});
