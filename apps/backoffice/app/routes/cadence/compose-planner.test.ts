import { describe, expect, test, assert } from "vitest";

import type { RouterContextProvider } from "react-router";

import { composeResultSchema } from "@/components/cadence/prompt/output/output-model";

import { handleComposeAction } from "./compose-action";
import { parseSteps, planCompose } from "./compose-planner";

const EXAMPLE =
  "When a customer cancels, survey them, revoke access at period end, and flag the account for win-back.";

describe("parseSteps", () => {
  test("starts with a trigger and ends with an output", () => {
    const steps = parseSteps(EXAMPLE);
    assert(steps[0].kind === "trigger");
    assert(steps[steps.length - 1].kind === "output");
    expect(steps.length).toBeGreaterThan(2);
  });

  test("falls back to a manual trigger for an empty prompt", () => {
    expect(parseSteps("")).toEqual([{ kind: "trigger", label: "Manual trigger" }]);
  });

  test("classifies notify/flag clauses as output", () => {
    const steps = parseSteps("When X happens, do the thing, notify the team");
    assert(steps.some((step) => step.kind === "output"));
  });
});

describe("planCompose", () => {
  test("produces a result that validates against the schema", () => {
    const result = planCompose(EXAMPLE);
    expect(() => composeResultSchema.parse(result)).not.toThrow();
    expect(result.prompt).toBe(EXAMPLE);
  });

  test("emits text, table, chart, and workflow blocks", () => {
    const types = planCompose(EXAMPLE).blocks.map((block) => block.type);
    expect(types).toEqual(expect.arrayContaining(["text", "table", "chart", "workflow"]));
  });

  test("the workflow block carries a wired graph (edges = nodes - 1)", () => {
    const workflow = planCompose(EXAMPLE).blocks.find((block) => block.type === "workflow");
    assert(workflow?.type === "workflow");
    if (workflow?.type === "workflow") {
      const { nodes, edges } = workflow.graph;
      expect(nodes.length).toBeGreaterThan(1);
      expect(edges.length).toBe(nodes.length - 1);
      // Nodes are laid out left-to-right at increasing x.
      for (let i = 1; i < nodes.length; i += 1) {
        expect(nodes[i].position.x).toBeGreaterThan(nodes[i - 1].position.x);
      }
    }
  });
});

describe("handleComposeAction", () => {
  // A context is never reached for the guard paths below; the request/context are
  // only used once a prompt and scope are present, which these cases short-circuit.
  const request = new Request("http://localhost/cadence");
  const context = {} as Readonly<RouterContextProvider>;

  test("rejects an empty prompt before touching any session", async () => {
    const formData = new FormData();
    formData.set("prompt", "   ");
    const response = await handleComposeAction({
      formData,
      request,
      context,
      scope: { kind: "org", orgId: "org-1" },
    });
    assert(!response.ok);
    if (!response.ok) {
      expect(response.error).toMatch(/describe/i);
    }
  });

  test("rejects a prompt with no active organisation", async () => {
    const formData = new FormData();
    formData.set("prompt", EXAMPLE);
    const response = await handleComposeAction({ formData, request, context, scope: null });
    assert(!response.ok);
    if (!response.ok) {
      expect(response.error).toMatch(/organisation/i);
    }
  });
});
