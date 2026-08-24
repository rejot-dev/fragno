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
const catalogReference =
  GENERATING_BACKOFFICE_UIS_SKILL_CONTENT["skills/generating-backoffice-uis/CATALOG.md"];
const workflowReference =
  GENERATING_BACKOFFICE_UIS_SKILL_CONTENT["skills/generating-backoffice-uis/WORKFLOWS.md"];

if (typeof skill !== "string") {
  throw new Error("Expected the generated Backoffice UI skill to contain text.");
}
if (typeof catalogReference !== "string") {
  throw new Error("Expected the generated Backoffice UI catalog reference to contain text.");
}
if (typeof workflowReference !== "string") {
  throw new Error("Expected the generated Backoffice UI workflow reference to contain text.");
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
  test("renders the production skill from the canonical catalog", () => {
    expect(skill).toContain("name: generating-backoffice-uis");
    expect(skill).toContain("## Result contract");
    expect(skill).toContain("## Branches");
    expect(skill).toContain("/static/skills/workflows/SKILL.md");
    expect(skill).toContain("/static/skills/generating-backoffice-uis/WORKFLOWS.md");
    expect(skill).toContain("/static/skills/generating-backoffice-uis/CATALOG.md");
    expect(skill).toContain("/static/skills/using-prepared-uploads/SKILL.md");
    expect(staticContent["skills/generating-backoffice-uis/CATALOG.md"]).toBe(catalogReference);
    expect(staticContent["skills/generating-backoffice-uis/WORKFLOWS.md"]).toBe(workflowReference);
    expect(skill).toContain("## Spec invariants");
    expect(skill).toContain("type StateVisibilityCondition");
    expect(catalogReference).toContain("# Production Component Catalog");
    expect(catalogReference).toContain("Props type:");
    expect(catalogReference).toContain("- columns: 1-12 items");
    expect(catalogReference).toContain("- rows[].*: at most 2000 characters");
    expect(skill).toMatch(/Raw HTML, scripts, iframes, embeds, arbitrary\s+URLs/u);
    expect(skill).toContain('read expressions such as `{ "$state": "/path" }` at any depth');
    expect(skill).toContain('`{ "$bindState": "/path" }` only as the complete top-level value');

    for (const [name, definition] of Object.entries(backofficeUiComponentDefinitions)) {
      expect(catalogReference).toContain(`### \`${name}\``);
      expect(catalogReference).toContain(definition.description);
      expect(catalogReference).toContain(JSON.stringify(definition.example, null, 2));
    }
  });

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

  test("discloses UI-specific durable workflow guidance without forking workflow rules", () => {
    expect(skill).toContain("/static/skills/workflows/SKILL.md");
    expect(skill).toContain("/static/skills/generating-backoffice-uis/WORKFLOWS.md");
    expect(skill).not.toContain("Keep external calls, time reads");
    expect(skill).not.toContain("do not rebuild state from local mutation");

    expect(workflowReference).toContain('step.do("build order report"');
    expect(workflowReference).toContain("Keep every identifier and value needed by later steps");
    expect(workflowReference).toContain("not the workflow's durable dataflow API");
    expect(workflowReference).toContain("renders it as the final output");
    expect(workflowReference).toContain("return report;");

    const stepResult = {
      orderIds: ["order-1", "order-2"],
      orderCount: 2,
      $ui: {
        version: 1,
        state: { orderCount: "2" },
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
    const parsedResult = parseBackofficeUiResult(stepResult);

    assert(parsedResult.kind === "valid");
    expect(parsedResult.value.orderIds).toEqual(["order-1", "order-2"]);
    assert.equal(parsedResult.value.orderCount, 2);
  });

  test("keeps detailed UI authoring guidance out of the static system prompt", () => {
    const systemGuidance = staticContent["SYSTEM.md"];
    if (typeof systemGuidance !== "string") {
      throw new Error("Expected static system guidance to contain text.");
    }

    expect(systemGuidance).toContain("Prefer acting over asking");
    expect(systemGuidance).toContain("Do not present executable code for the user to run");
    expect(systemGuidance).toContain("Immediate work uses a top-level async function");
    expect(systemGuidance).toContain('state.find("/workspace"');
    expect(systemGuidance).not.toContain('state.find("/events"');
    expect(systemGuidance).toMatch(/Define a durable workflow\s+directly at the top level/u);
    expect(systemGuidance).toContain("Do not wrap `defineWorkflow` inside an async function");
    expect(systemGuidance).toContain("workflow.getInstance({ instanceId })");
    expect(systemGuidance).toMatch(/the returned handle alone is not\s+completion/u);
    expect(systemGuidance).toContain(
      "Declarations tell you what can be called; runtime checks tell you what is currently usable",
    );
    expect(systemGuidance).toContain("`/providers` contains the complete, stable Backoffice API");
    expect(systemGuidance).toContain(
      "`/sources` contains dynamically discovered APIs for the current context",
    );
    expect(systemGuidance).toMatch(
      /confirm the method exists, required services are configured, scopes are\s+concrete, and event types are exact/u,
    );
    expect(systemGuidance).toContain("report an unavailable requirement as blocking");
    expect(systemGuidance).toContain("Classify execution errors from their messages");
    expect(systemGuidance).toMatch(/Report\s+success only from an executed result/u);
    expect(systemGuidance).toContain("A scope is the ownership and authorization boundary");
    expect(systemGuidance).toContain("context.getCurrentScope()");
    expect(systemGuidance).toContain("context.current.store.get(...)");
    expect(systemGuidance).toContain("context.org(orgId)");
    expect(systemGuidance).toContain("context.user(userId)");
    expect(systemGuidance).toContain("context.project(projectId)");
    expect(systemGuidance).toMatch(/only visible in\s+system\/admin contexts/u);
    expect(systemGuidance).toContain("must return JSON-serializable values");
    expect(systemGuidance).not.toMatch(/bash/iu);
    expect(systemGuidance).not.toContain("BackofficeUiResult");
    expect(systemGuidance).not.toContain("Production Component Catalog");
    expect(systemGuidance).not.toContain("$ui");
  });

  test("discloses the prepared upload lifecycle through one capability skill", () => {
    const uploadSkill = staticContent["skills/using-prepared-uploads/SKILL.md"];
    if (typeof uploadSkill !== "string") {
      throw new Error("Expected the prepared Upload lifecycle skill to contain text.");
    }

    expect(uploadSkill).toContain("/static/codemode/providers/upload.d.ts");
    expect(uploadSkill).toContain("upload.readPrepared");
    expect(uploadSkill).toContain('encoding: "bytes"');
    expect(uploadSkill).toMatch(/pass those\s+bytes directly to binary consumers/u);
    expect(uploadSkill).toContain("not raw bytes");
    expect(uploadSkill).toContain("upload.commitPrepared");
    expect(uploadSkill).toContain("upload.discardPrepared");
    expect(uploadSkill).toContain('{ kind: "current" }');
    expect(skill).not.toContain("upload.readPrepared");
  });
});
