import { describe, expect, test, assert } from "vitest";

import {
  composeBlockSchema,
  firstWorkflowBlock,
  workflowGraphSchema,
  type ComposeBlock,
} from "./output-model";

describe("composeBlockSchema", () => {
  test("parses each block variant by its discriminant", () => {
    const blocks: ComposeBlock[] = [
      { id: "a", type: "text", markdown: "hello" },
      { id: "b", type: "table", columns: ["x"], rows: [[1], ["y"], [null]] },
      {
        id: "c",
        type: "chart",
        variant: "bar",
        categories: ["jan", "feb"],
        series: [{ name: "s", values: [1, 2] }],
      },
      {
        id: "d",
        type: "workflow",
        title: "wf",
        graph: { nodes: [], edges: [] },
      },
    ];

    for (const block of blocks) {
      expect(() => composeBlockSchema.parse(block)).not.toThrow();
    }
  });

  test("rejects an unknown block type", () => {
    expect(() => composeBlockSchema.parse({ id: "x", type: "video" })).toThrow();
  });
});

describe("workflowGraphSchema", () => {
  test("accepts a valid graph", () => {
    const graph = {
      nodes: [{ id: "n1", kind: "trigger", label: "Start", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(() => workflowGraphSchema.parse(graph)).not.toThrow();
  });

  test("rejects an invalid node kind", () => {
    const graph = {
      nodes: [{ id: "n1", kind: "loop", label: "Start", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(() => workflowGraphSchema.parse(graph)).toThrow();
  });
});

describe("firstWorkflowBlock", () => {
  test("finds the first workflow block, ignoring others", () => {
    const blocks: ComposeBlock[] = [
      { id: "a", type: "text", markdown: "hi" },
      { id: "b", type: "workflow", title: "wf", graph: { nodes: [], edges: [] } },
    ];
    assert(firstWorkflowBlock(blocks)?.id === "b");
    expect(firstWorkflowBlock([{ id: "a", type: "text", markdown: "hi" }])).toBeUndefined();
  });
});
