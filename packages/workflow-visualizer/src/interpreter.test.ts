import { describe, expect, it, assert } from "vitest";

import { buildCodemodeWorkflowGraph } from "./build.ts";
import { createInterpreter } from "./interpreter.ts";
import type { GraphPatch, LoopNode, StepNode, WorkflowNode } from "./model.ts";
import { workflowNodeId } from "./model.ts";

describe("createInterpreter", () => {
  it("parses an early-return guard with a reason as a guard step", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/test-command.workflow.js",
      `defineWorkflow({ name: "test-command" }, async (event, step) => {
        const text = event.payload.text;
        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }
        await step.do("run tests", async () => {});
      });`,
    );
    const steps = interp.snapshot().nodes.filter((n): n is StepNode => n.kind === "step");
    expect(steps.map((s) => s.stepType)).toEqual(["guard", "do"]);

    const guard = steps[0];
    assert(guard?.stepType === "guard");
    // the bail `reason` reads as the human-meaningful label
    assert(guard.label === "not-test-command");
    assert(guard.meta.condition === 'text !== "/test"');
    assert(guard.meta.returns === '{ skipped: true, reason: "not-test-command" }');
  });

  it("annotates steps nested inside conditionals", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/x.workflow.js",
      `defineWorkflow({ name: "x" }, async (event, step) => {
        if (event.payload.linked) {
          await step.do("send already linked", async () => {});
        }
      });`,
    );
    const step = interp.snapshot().nodes.find((n): n is StepNode => n.kind === "step");
    expect(step?.branch).toEqual(["event.payload.linked"]);
  });

  it("turns loops into nested container blocks the loop body parents into", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/loop.workflow.js",
      `defineWorkflow({ name: "loop" }, async (event, step) => {
        for (const repo of event.payload.repos) {
          if (repo.active) {
            while (repo.hasMore) {
              await step.do("sync repo page", async () => {});
            }
          }
        }
        await step.do("finalize", async () => {});
      });`,
    );
    const graph = interp.snapshot();
    const loops = graph.nodes.filter((n): n is LoopNode => n.kind === "loop");
    const steps = graph.nodes.filter((n): n is StepNode => n.kind === "step");
    const workflowId = workflowNodeId("loop");

    // Two loop blocks: the outer `for` parents into the workflow, the inner
    // `while` parents into the `for`.
    const forLoop = loops.find((l) => l.loopKind === "forOf");
    const whileLoop = loops.find((l) => l.loopKind === "while");
    assert(forLoop?.label === "for (const repo of event.payload.repos)");
    expect(forLoop?.parentId).toBe(workflowId);
    assert(whileLoop?.label === "while (repo.hasMore)");
    expect(whileLoop?.parentId).toBe(forLoop?.id);
    // The `if` between the two loops is reported on the inner loop as a branch.
    expect(whileLoop?.branch).toEqual(["repo.active"]);

    // The step nests inside the inner loop; the branch is consumed by the loop,
    // so the step itself carries no branch.
    const sync = steps.find((s) => s.label === "sync repo page");
    expect(sync?.parentId).toBe(whileLoop?.id);
    expect(sync?.branch).toEqual([]);

    // A step outside every loop parents straight into the workflow.
    const finalize = steps.find((s) => s.label === "finalize");
    expect(finalize?.parentId).toBe(workflowId);

    // Containment + sequencing: the `for` and `finalize` are siblings under the
    // workflow, sequenced in source order.
    const seq = graph.edges.filter((e) => e.type === "sequence");
    expect(seq).toContainEqual(
      expect.objectContaining({ from: forLoop?.id, to: finalize?.id, type: "sequence" }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: whileLoop?.id, to: sync?.id, type: "contains" }),
    );
  });

  it("prunes loop blocks that contain no steps", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/empty-loop.workflow.js",
      `defineWorkflow({ name: "el" }, async (event, step) => {
        for (const x of event.payload.items) {
          console.log(x);
        }
        await step.do("done", async () => {});
      });`,
    );
    const graph = interp.snapshot();
    expect(graph.nodes.filter((n) => n.kind === "loop")).toHaveLength(0);
    const done = graph.nodes.find((n): n is StepNode => n.kind === "step");
    expect(done?.parentId).toBe(workflowNodeId("el"));
  });

  it("streams patches as files change, and resets new subscribers", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/a.workflow.js",
      `defineWorkflow({ name: "a" }, async (e, step) => {});`,
    );

    const patches: GraphPatch[] = [];
    const unsubscribe = interp.onPatch((p) => patches.push(p));

    // first patch to a new subscriber is always a full reset
    assert(patches[0]?.type === "reset");

    interp.updateFile(
      "automations/a.workflow.js",
      `defineWorkflow({ name: "a" }, async (e, step) => { await step.do("new", async () => {}); });`,
    );

    const upserts = patches.filter((p) => p.type === "node.upsert");
    assert(upserts.some((p) => p.type === "node.upsert" && p.node.kind === "step"));

    unsubscribe();
    const before = patches.length;
    interp.removeFile("automations/a.workflow.js");
    expect(patches.length).toBe(before); // no more delivery after unsubscribe
  });

  it("parses a defineWorkflow input schema into form field descriptors", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/schema.workflow.js",
      `defineWorkflow(
        {
          name: "schema-flow",
          schema: z.object({
            repo: z.string().describe("owner/name"),
            pr: z.number(),
            dryRun: z.boolean().optional(),
            tier: z.enum(["free", "pro"]).default("free"),
          }),
        },
        async (event, step) => {
          await step.do("noop", async () => {});
        },
      );`,
    );

    const workflow = interp.snapshot().nodes.find((n): n is WorkflowNode => n.kind === "workflow");
    expect(workflow?.inputSchema).toEqual([
      { name: "repo", type: "string", optional: false, description: "owner/name" },
      { name: "pr", type: "number", optional: false },
      { name: "dryRun", type: "boolean", optional: true },
      { name: "tier", type: "enum", optional: false, enumValues: ["free", "pro"] },
    ]);
  });

  it("omits inputSchema when no analyzable schema is declared", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "automations/plain.workflow.js",
      `defineWorkflow({ name: "plain" }, async (event, step) => {
        await step.do("noop", async () => {});
      });`,
    );
    const workflow = interp.snapshot().nodes.find((n): n is WorkflowNode => n.kind === "workflow");
    expect(workflow?.inputSchema).toBeUndefined();
  });
});

describe("buildCodemodeWorkflowGraph", () => {
  it("parses a bare codemode run function into a named workflow + steps", () => {
    const graph = buildCodemodeWorkflowGraph(
      `async (event, step) => {
        const a = await step.do("first", async () => {});
        await step.sleep("pause", "5 minutes");
        return a;
      }`,
      { name: "order-sync" },
    );

    const workflow = graph.nodes.find((n): n is WorkflowNode => n.kind === "workflow");
    // Anonymous functions get their name from the supplied label.
    assert(workflow?.name === "order-sync");

    const steps = graph.nodes.filter((n): n is StepNode => n.kind === "step");
    expect(steps.map((s) => s.label)).toEqual(["first", "pause"]);
    assert(steps[1]?.stepType === "sleep");
    assert(steps[1]?.meta.duration === "5 minutes");
    // workflow --contains--> step --sequence--> step
    assert(graph.edges.some((e) => e.type === "contains" && e.to === steps[0]?.id));
    assert(graph.edges.some((e) => e.type === "sequence"));
    expect(graph.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("parses a `{ name, run }` codemode definition object", () => {
    const graph = buildCodemodeWorkflowGraph(
      `({
        name: "named-flow",
        run: async (event, step) => {
          await step.do("only", async () => {});
        },
      })`,
    );
    const workflow = graph.nodes.find((n): n is WorkflowNode => n.kind === "workflow");
    // The object's own `name` wins over the path-derived fallback.
    assert(workflow?.name === "named-flow");
    expect(graph.nodes.filter((n): n is StepNode => n.kind === "step").map((s) => s.label)).toEqual(
      ["only"],
    );
  });

  it("still parses a defineWorkflow codemode script", () => {
    const graph = buildCodemodeWorkflowGraph(
      `defineWorkflow({ name: "via-define" }, async (event, step) => {
        await step.do("compute", async () => {});
      })`,
    );
    const workflow = graph.nodes.find((n): n is WorkflowNode => n.kind === "workflow");
    assert(workflow?.name === "via-define");
  });
});
