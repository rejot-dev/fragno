import { assert, describe, expect, it } from "vitest";

import {
  createWorkflowTokenMachine,
  renderWorkflowVisualizationText,
  visualizeWorkflowSource,
} from "./index.ts";
import type {
  GraphNode,
  GraphPatch,
  StepNode,
  TerminalNode,
  WorkflowGraph,
  WorkflowNode,
} from "./model.ts";
import { loadBackofficeAutomationFixtures } from "./test-support/backoffice-automation-fixtures.ts";
import { tokenizeWorkflowSource } from "./tokenizer.ts";

const AUTOMATIONS = new Map(await loadBackofficeAutomationFixtures());

const EXPECTED_DURABLE_STEPS: Record<string, string[]> = {
  "automations/telegram-user-linking.workflow.js": [
    "lookup existing telegram user link",
    "send already linked telegram message",
    "create telegram identity claim",
    "store telegram claim workflow binding",
    "send telegram identity claim link",
    "identity-claim-completed",
    "bind telegram user",
    "send telegram user linked message",
  ],
  "automations/telegram-user-pi-linking.workflow.js": [
    "lookup linked telegram user",
    "lookup default pi agent",
    "lookup pi session",
    "check existing pi session",
    "create pi session",
    "store pi session binding",
    "reply to pi command if needed",
    "send telegram typing action",
    "run pi turn",
    "send pi response if needed",
  ],
  "automations/pi-default-agent-configure.workflow.js": ["store default pi agent"],
  "automations/telegram-test-command.workflow.js": ["wait 3 seconds", "send delayed test reply"],
  "automations/project-files-configure.workflow.js": ["configure project database filesystem"],
  "automations/workspace-file-initialization.workflow.js": [
    "configure upload database connection",
    "seed workspace starter files",
    "seed starter automation routes",
  ],
};

describe("workflow token state machine", () => {
  it.each([...AUTOMATIONS])("keeps every token prefix usable for %s", (path, source) => {
    const machine = createWorkflowTokenMachine({ path });

    for (const token of tokenizeWorkflowSource(source)) {
      const update = machine.push(token);
      assert(update.graph.version === 4);
      assert(update.state.sourceLength === machine.source().length);
      assertUsableGraph(update.graph.nodes, update.graph.edges);
    }

    const finished = machine.finish();
    const workflow = finished.graph.nodes.find(
      (node): node is WorkflowNode => node.kind === "workflow",
    );
    const steps = finished.graph.nodes.filter((node): node is StepNode => node.kind === "step");

    assert(workflow?.name === path.split("/").at(-1)?.split(".")[0]);
    expect(workflow?.construction).toEqual({ status: "complete", phase: "complete" });
    expect(steps.map((step) => step.label)).toEqual(EXPECTED_DURABLE_STEPS[path]);
    assert(steps.every((step) => step.construction.status === "complete"));
    expect(finished.graph.diagnostics).toEqual([]);
  });

  it("extracts fixture metadata and branch state without an AST", () => {
    const testCommand = visualizeFixture("automations/telegram-test-command.workflow.js");
    const testSteps = testCommand.graph.nodes.filter(
      (node): node is StepNode => node.kind === "step",
    );
    const testExit = testCommand.graph.nodes.find(
      (node): node is TerminalNode =>
        node.kind === "terminal" && node.terminalType === "early-return",
    );
    expect(testExit).toMatchObject({
      label: "not-test-command",
      value: '{ skipped: true, reason: "not-test-command" }',
    });
    expect(testSteps[0]).toMatchObject({
      label: "wait 3 seconds",
      stepType: "sleep",
      meta: { duration: "3 seconds" },
    });

    const linking = visualizeFixture("automations/telegram-user-linking.workflow.js");
    const linkingSteps = linking.graph.nodes.filter(
      (node): node is StepNode => node.kind === "step",
    );
    expect(linkingSteps.find((step) => step.stepType === "waitForEvent")).toMatchObject({
      label: "identity-claim-completed",
      meta: { eventType: "identity-claim-completed", timeout: "15 minutes" },
    });
    const linkedMessage = linkingSteps.find(
      (step) => step.label === "send already linked telegram message",
    );
    assert(linkedMessage);
    expect(ancestorLabels(linking.graph, linkedMessage)).toEqual([
      "if linkedUser?.value",
      "telegram-user-linking",
    ]);

    const initialization = visualizeFixture(
      "automations/workspace-file-initialization.workflow.js",
    );
    const thrown = initialization.graph.nodes.find(
      (node): node is TerminalNode => node.kind === "terminal" && node.terminalType === "error",
    );
    expect(thrown).toMatchObject({
      label: "organization.created event is missing subject.orgId.",
      value: 'new Error("organization.created event is missing subject.orgId.")',
    });
  });

  it("recognizes a specific event guard through a local constant binding", () => {
    const source = `defineWorkflow({ name: "event-guard" }, async (event, step) => {
      const automationEvent = event.payload.automationEvent;

      if (
        automationEvent.source !== "pi" ||
        automationEvent.eventType !== "capability.configured"
      ) {
        return { skipped: true, reason: "not-pi-capability-configured" };
      }

      await step.do("configure pi", async () => {});
    });`;
    const snapshot = visualizeWorkflowSource("automations/event-guard.workflow.js", source);
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");

    assert(condition?.kind === "condition");
    expect(condition.analysis).toEqual({
      status: "complete",
      predicate: {
        kind: "any",
        predicates: [
          {
            kind: "comparison",
            operator: "not-equals",
            left: {
              kind: "reference",
              root: "event",
              path: ["payload", "automationEvent", "source"],
            },
            right: { kind: "literal", value: "pi" },
          },
          {
            kind: "comparison",
            operator: "not-equals",
            left: {
              kind: "reference",
              root: "event",
              path: ["payload", "automationEvent", "eventType"],
            },
            right: { kind: "literal", value: "capability.configured" },
          },
        ],
      },
      outcomes: expect.any(Array),
      annotations: [
        {
          kind: "specific-event-guard",
          subject: {
            kind: "reference",
            root: "event",
            path: ["payload", "automationEvent"],
          },
          eventSource: "pi",
          eventType: "capability.configured",
          acceptedPath: "fallthrough",
          rejectedTerminalId: expect.any(String),
          rejectionReason: "not-pi-capability-configured",
        },
      ],
    });
    const acceptedOutcome =
      condition.analysis.status === "complete"
        ? condition.analysis.outcomes.find((outcome) => outcome.path === "fallthrough")
        : undefined;
    expect(acceptedOutcome).toMatchObject({
      predicate: {
        kind: "all",
        predicates: [
          { kind: "comparison", operator: "equals" },
          { kind: "comparison", operator: "equals" },
        ],
      },
      completion: { kind: "continues" },
    });
  });

  it("retains source ranges that select complete graph constructs", () => {
    const source = `defineWorkflow({ name: "source-ranges" }, async (event, step) => {
      if (event.payload.skip) {
        return { skipped: true, reason: "skip" };
      }
      await step.do("complete work", async () => {});
    });`;
    const snapshot = visualizeWorkflowSource("automations/source-ranges.workflow.js", source);
    const workflow = snapshot.graph.nodes.find((node) => node.kind === "workflow");
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");
    const terminal = snapshot.graph.nodes.find((node) => node.kind === "terminal");
    const step = snapshot.graph.nodes.find((node) => node.kind === "step");

    assert(workflow?.kind === "workflow");
    assert(condition?.kind === "condition");
    assert(terminal?.kind === "terminal");
    assert(step?.kind === "step");
    expect(source.slice(workflow.source.start.offset, workflow.source.end.offset)).toMatch(
      /^defineWorkflow[\s\S]*\)$/u,
    );
    assert.equal(
      source.slice(condition.source.start.offset, condition.source.end.offset),
      `if (event.payload.skip) {
        return { skipped: true, reason: "skip" };
      }`,
    );
    assert.equal(
      source.slice(terminal.source.start.offset, terminal.source.end.offset),
      'return { skipped: true, reason: "skip" };',
    );
    assert.equal(
      source.slice(step.source.start.offset, step.source.end.offset),
      'step.do("complete work", async () => {})',
    );
    expect(condition.source).toMatchObject({
      path: "automations/source-ranges.workflow.js",
      start: { line: 2, column: 6 },
      end: { line: 4, column: 7 },
    });

    const unbracedSource = `defineWorkflow({ name: "unbraced-range" }, async (event, step) => {
      if (event.payload.skip) return { skipped: true, reason: "skip" };
      await step.do("continue", async () => {});
    });`;
    const unbraced = visualizeWorkflowSource(
      "automations/unbraced-range.workflow.js",
      unbracedSource,
    ).graph.nodes.find((node) => node.kind === "condition");
    assert(unbraced?.kind === "condition");
    assert.equal(
      unbracedSource.slice(unbraced.source.start.offset, unbraced.source.end.offset),
      'if (event.payload.skip) return { skipped: true, reason: "skip" };',
    );
  });

  it("recognizes TypeScript-generic workflow step calls", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/generic-step.workflow.ts",
      `defineWorkflow({ name: "generic-step" }, async (event, step) => {
        await step.waitForEvent<{ approved: boolean }>("approval", {
          type: "approval",
        });
      });`,
    );

    expect(snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step")).toEqual([
      expect.objectContaining({
        label: "approval",
        stepType: "waitForEvent",
        meta: { eventType: "approval" },
      }),
    ]);
  });

  it("recognizes function-expression workflow callbacks", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/function-expression.workflow.js",
      `defineWorkflow({ name: "function-expression" }, async function run(event, workflowStep) {
        await workflowStep.do("inside function expression", async () => {});
      });`,
    );

    expect(snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step")).toEqual([
      expect.objectContaining({
        label: "inside function expression",
        stepType: "do",
      }),
    ]);
  });

  it("ends unbraced branches at automatic semicolon insertion boundaries", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/semicolonless.workflow.js",
      `defineWorkflow({ name: "semicolonless" }, async (event, step) => {
        if (event.payload.skip)
          return { skipped: true, reason: "skip" }
        if (event.payload.log)
          console.log("logging")
        await step.do("after guards", async () => {})
      })`,
    );
    const steps = snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step");
    const terminal = snapshot.graph.nodes.find(
      (node): node is TerminalNode =>
        node.kind === "terminal" && node.terminalType === "early-return",
    );

    expect(steps).toEqual([
      expect.objectContaining({
        label: "after guards",
        stepType: "do",
      }),
    ]);
    expect(terminal).toMatchObject({
      label: "skip",
      value: '{ skipped: true, reason: "skip" }',
    });
    assert(terminal);
    expect(ancestorLabels(snapshot.graph, terminal)).toEqual([
      "if event.payload.skip",
      "semicolonless",
    ]);
    expect(ancestorLabels(snapshot.graph, steps[0]!)).toEqual(["semicolonless"]);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "condition")).toHaveLength(1);
  });

  it("composes nested if, else, else-if, and return submachines", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/branches.workflow.js",
      `defineWorkflow({ name: "branches" }, async (event, step) => {
        if (event.payload.ready) {
          await step.do("ready", async () => {});
        } else if (event.payload.retry) {
          return { skipped: true, reason: "retry-later" };
        } else {
          await step.do("fallback", async () => {});
        }
        await step.do("done", async () => {});
      });`,
    );
    const steps = snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step");
    const retryTerminal = snapshot.graph.nodes.find(
      (node): node is TerminalNode => node.kind === "terminal" && node.label === "retry-later",
    );

    expect(steps.map((step) => step.label)).toEqual(["ready", "fallback", "done"]);
    expect(ancestorLabels(snapshot.graph, steps[0]!)).toEqual([
      "then",
      "if event.payload.ready",
      "branches",
    ]);
    assert(retryTerminal);
    expect(ancestorLabels(snapshot.graph, retryTerminal)).toEqual([
      "then",
      "if event.payload.retry",
      "else",
      "if event.payload.ready",
      "branches",
    ]);
    expect(ancestorLabels(snapshot.graph, steps[1]!)).toEqual([
      "else",
      "if event.payload.retry",
      "else",
      "if event.payload.ready",
      "branches",
    ]);
    expect(ancestorLabels(snapshot.graph, steps[2]!)).toEqual(["branches"]);
    expect(retryTerminal).toMatchObject({
      terminalType: "early-return",
      value: '{ skipped: true, reason: "retry-later" }',
    });
  });

  it("parents conditionally executed steps directly to an if without an else", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/conditional-session.workflow.js",
      `defineWorkflow({ name: "conditional-session" }, async (event, step) => {
        if (!reusableSession.reusable) {
          const session = await step.do("create pi session", async () => {
            return await pi.createSession({ agent: defaultAgent });
          });
          await step.do("store pi session binding", async () => {
            await store.set({ value: session.id });
          });
        }
      });`,
    );
    const workflow = snapshot.graph.nodes.find(
      (node): node is WorkflowNode => node.kind === "workflow",
    );
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");
    const steps = snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step");

    assert(workflow);
    assert(condition?.kind === "condition");
    expect(condition).toMatchObject({
      condition: "!reusableSession.reusable",
      parentId: workflow.id,
    });
    expect(snapshot.graph.nodes.filter((node) => node.kind === "branch")).toEqual([]);
    expect(
      steps.map((step) => ({ label: step.label, parentId: step.parentId, order: step.order })),
    ).toEqual([
      { label: "create pi session", parentId: condition.id, order: 0 },
      { label: "store pi session binding", parentId: condition.id, order: 1 },
    ]);
    expect(snapshot.graph.edges).toContainEqual(
      expect.objectContaining({
        from: steps[0]?.id,
        to: steps[1]?.id,
        type: "sequence",
      }),
    );
  });

  it("keeps explicit then and else branches as alternative containers", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/if-else.workflow.js",
      `defineWorkflow({ name: "if-else" }, async (event, step) => {
        if (event.payload.ready) {
          await step.do("ready path", async () => {});
        } else {
          await step.do("fallback path", async () => {});
        }
        return { done: true };
      });`,
    );
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");
    const branches = snapshot.graph.nodes
      .filter((node) => node.kind === "branch")
      .sort((left, right) => left.index - right.index);

    assert(condition?.kind === "condition");
    expect(branches.map((branch) => branch.branchType)).toEqual(["then", "else"]);
    assert(branches.every((branch) => branch.parentId === condition.id));
    expect(ancestorLabels(snapshot.graph, stepByLabel(snapshot.graph, "ready path"))).toEqual([
      "then",
      "if event.payload.ready",
      "if-else",
    ]);
    expect(ancestorLabels(snapshot.graph, stepByLabel(snapshot.graph, "fallback path"))).toEqual([
      "else",
      "if event.payload.ready",
      "if-else",
    ]);
    assert(
      !snapshot.graph.edges.some(
        (edge) =>
          edge.type === "sequence" &&
          branches.some((branch) => branch.id === edge.from) &&
          branches.some((branch) => branch.id === edge.to),
      ),
    );
  });

  it("keeps ternary step calls in explicit alternative branches", () => {
    const source = `defineWorkflow({ name: "conditional-expression" }, async (event, step) => {
      const sample = await step.do("sample", async () => ({ value: Math.random() }));
      const branch = sample.value >= 0.5
        ? await step.do("conditional-high-branch", async () => ({ branch: "high", readOnly: true }))
        : await step.do("conditional-low-branch", async () => ({ branch: "low", readOnly: true }));
      return branch;
    });`;
    const snapshot = visualizeWorkflowSource("automations/conditional-expression.ts", source);
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");
    const branches = snapshot.graph.nodes
      .filter((node) => node.kind === "branch")
      .sort((left, right) => left.index - right.index);
    const highBranch = stepByLabel(snapshot.graph, "conditional-high-branch");
    const lowBranch = stepByLabel(snapshot.graph, "conditional-low-branch");

    assert(condition?.kind === "condition");
    expect(condition).toMatchObject({
      label: "if sample.value >= 0.5",
      condition: "sample.value >= 0.5",
      construction: { status: "complete", phase: "complete" },
      analysis: { status: "unsupported", outcomes: [], annotations: [] },
    });
    expect(branches.map((branch) => branch.branchType)).toEqual(["then", "else"]);
    expect(ancestorLabels(snapshot.graph, highBranch)).toEqual([
      "then",
      "if sample.value >= 0.5",
      "conditional-expression",
    ]);
    expect(ancestorLabels(snapshot.graph, lowBranch)).toEqual([
      "else",
      "if sample.value >= 0.5",
      "conditional-expression",
    ]);
    assert.equal(
      source.slice(condition.source.start.offset, condition.source.end.offset),
      `sample.value >= 0.5
        ? await step.do("conditional-high-branch", async () => ({ branch: "high", readOnly: true }))
        : await step.do("conditional-low-branch", async () => ({ branch: "low", readOnly: true }))`,
    );
    assert(
      !snapshot.graph.edges.some(
        (edge) =>
          edge.type === "sequence" &&
          ((edge.from === highBranch.id && edge.to === lowBranch.id) ||
            (edge.from === lowBranch.id && edge.to === highBranch.id)),
      ),
    );
  });

  it("does not treat TypeScript optional markers as conditional expressions", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/typescript-optionals.workflow.ts",
      `defineWorkflow({ name: "typescript-optionals" }, async (event, step) => {
        type OptionalPayload = { value?: string };
        const normalize = (value?: string) => value ?? "missing";
        await step.do("after optional markers", async () => normalize(event.payload.value));
      });`,
    );
    const step = stepByLabel(snapshot.graph, "after optional markers");

    expect(snapshot.graph.nodes.filter((node) => node.kind === "condition")).toEqual([]);
    expect(ancestorLabels(snapshot.graph, step)).toEqual(["typescript-optionals"]);
  });

  it.each(["as", "satisfies"])(
    "keeps a multiline TypeScript %s operator attached to its conditional expression",
    (operator) => {
      const source = `defineWorkflow({ name: "typescript-${operator}-conditional" }, async (event, step) => {
        const branch = event.payload
          ${operator}
          { ready: boolean }
          ? await step.do("ready branch", async () => ({ ready: true }))
          : await step.do("fallback branch", async () => ({ ready: false }));
      });`;
      const snapshot = visualizeWorkflowSource(
        `automations/typescript-${operator}-conditional.workflow.ts`,
        source,
      );
      const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");

      assert(condition?.kind === "condition");
      const conditionSource = source.slice(
        condition.source.start.offset,
        condition.source.end.offset,
      );
      assert(conditionSource.startsWith("event.payload"));
      assert(conditionSource.includes(`\n          ${operator}\n`));
    },
  );

  it("keeps incomplete ternary branches structurally usable while tokens arrive", () => {
    const machine = createWorkflowTokenMachine({
      path: "automations/incremental-conditional-expression.ts",
    });
    const firstChunk = `defineWorkflow({ name: "incremental-conditional-expression" }, async (event, step) => {
      const branch = event.payload.ready
        ? await step.do("ready branch", async () => ({ ready: true }))`;

    for (const token of tokenizeWorkflowSource(firstChunk)) {
      const update = machine.push(token);
      assertUsableGraph(update.graph.nodes, update.graph.edges);
    }

    const partial = machine.snapshot().graph;
    const partialCondition = partial.nodes.find((node) => node.kind === "condition");
    assert(partialCondition?.kind === "condition");
    expect(partialCondition.construction).toEqual({ status: "partial", phase: "branches" });
    expect(ancestorLabels(partial, stepByLabel(partial, "ready branch"))).toEqual([
      "if event.payload.ready",
      "incremental-conditional-expression",
    ]);

    const finalChunk = `
        : await step.do("fallback branch", async () => ({ ready: false }));
    });`;
    for (const token of tokenizeWorkflowSource(finalChunk)) {
      const update = machine.push(token);
      assertUsableGraph(update.graph.nodes, update.graph.edges);
    }

    const finished = machine.finish().graph;
    expect(finished.nodes.filter((node) => node.kind === "branch")).toHaveLength(2);
    expect(ancestorLabels(finished, stepByLabel(finished, "fallback branch"))).toEqual([
      "else",
      "if event.payload.ready",
      "incremental-conditional-expression",
    ]);
    expect(finished.diagnostics).toEqual([]);
  });

  it("reparents a direct if child when an else branch arrives incrementally", () => {
    const machine = createWorkflowTokenMachine({
      path: "automations/incremental-else.workflow.js",
    });
    machine.pushAll(
      tokenizeWorkflowSource(
        `defineWorkflow({ name: "incremental-else" }, async (event, step) => {
          if (event.payload.ready) {
            await step.do("ready path", async () => {});
          }`,
      ),
    );

    const beforeElse = machine.snapshot().graph;
    const condition = beforeElse.nodes.find((node) => node.kind === "condition");
    assert(condition?.kind === "condition");
    expect(stepByLabel(beforeElse, "ready path").parentId).toBe(condition.id);
    expect(beforeElse.nodes.filter((node) => node.kind === "branch")).toEqual([]);

    machine.pushAll(
      tokenizeWorkflowSource(
        ` else {
            await step.do("fallback path", async () => {});
          }
        });`,
      ),
    );
    const afterElse = machine.finish().graph;
    const branches = afterElse.nodes
      .filter((node) => node.kind === "branch")
      .sort((left, right) => left.index - right.index);

    expect(branches.map((branch) => branch.branchType)).toEqual(["then", "else"]);
    expect(stepByLabel(afterElse, "ready path").parentId).toBe(branches[0]?.id);
    expect(stepByLabel(afterElse, "fallback path").parentId).toBe(branches[1]?.id);
  });

  it("represents early exits, errors, and final returns as terminal nodes", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/terminals.workflow.js",
      `defineWorkflow({ name: "terminals" }, async (event, step) => {
        if (event.payload.skip) return { skipped: true, reason: "skip" };
        if (event.payload.invalid) throw new Error("invalid payload");
        await step.do("complete work", async () => {});
        return { ok: true };
      });`,
    );
    const terminals = snapshot.graph.nodes.filter(
      (node): node is TerminalNode => node.kind === "terminal",
    );

    expect(
      terminals.map(({ terminalType, label, value }) => ({ terminalType, label, value })),
    ).toEqual([
      {
        terminalType: "early-return",
        label: "skip",
        value: '{ skipped: true, reason: "skip" }',
      },
      {
        terminalType: "error",
        label: "invalid payload",
        value: 'new Error("invalid payload")',
      },
      { terminalType: "final-return", label: "return", value: "{ ok: true }" },
    ]);
    expect(ancestorLabels(snapshot.graph, terminals[0]!)).toEqual([
      "if event.payload.skip",
      "terminals",
    ]);
    expect(ancestorLabels(snapshot.graph, terminals[1]!)).toEqual([
      "if event.payload.invalid",
      "terminals",
    ]);
    expect(ancestorLabels(snapshot.graph, terminals[2]!)).toEqual(["terminals"]);
    expect(snapshot.graph.edges).toContainEqual(
      expect.objectContaining({
        from: stepByLabel(snapshot.graph, "complete work").id,
        to: terminals[2]?.id,
        type: "sequence",
      }),
    );
  });

  it("orders a step wrapped by return before its final terminal", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/return-step.workflow.js",
      `defineWorkflow({ name: "return-step" }, async (event, step) => {
        return await step.do("produce result", async () => ({ ok: true }));
      });`,
    );
    const step = stepByLabel(snapshot.graph, "produce result");
    const terminal = snapshot.graph.nodes.find(
      (node): node is TerminalNode =>
        node.kind === "terminal" && node.terminalType === "final-return",
    );

    assert(terminal);
    expect({
      stepOrder: step.order,
      terminalOrder: terminal.order,
      terminalValue: terminal.value,
    }).toEqual({
      stepOrder: 0,
      terminalOrder: 1,
      terminalValue: "",
    });
    expect(snapshot.graph.edges).toContainEqual(
      expect.objectContaining({ from: step.id, to: terminal.id, type: "sequence" }),
    );
  });

  it("orders a ternary wrapped by return before its final terminal", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/return-conditional-expression.workflow.ts",
      `defineWorkflow({ name: "return-conditional-expression" }, async (event, step) => {
        return event.payload.ready
          ? await step.do("return ready branch", async () => ({ ready: true }))
          : await step.do("return fallback branch", async () => ({ ready: false }));
      });`,
    );
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");
    const terminal = snapshot.graph.nodes.find(
      (node): node is TerminalNode =>
        node.kind === "terminal" && node.terminalType === "final-return",
    );

    assert(condition?.kind === "condition");
    assert(terminal);
    expect({ conditionOrder: condition.order, terminalOrder: terminal.order }).toEqual({
      conditionOrder: 0,
      terminalOrder: 1,
    });
    expect(snapshot.graph.edges).toContainEqual(
      expect.objectContaining({ from: condition.id, to: terminal.id, type: "sequence" }),
    );
    expect(snapshot.graph.edges).not.toContainEqual(
      expect.objectContaining({ from: terminal.id, to: condition.id, type: "sequence" }),
    );
    assert(terminal.value === "");
  });

  it("preserves a return terminal when a ternary has no durable work", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/plain-return-conditional-expression.workflow.ts",
      `defineWorkflow({ name: "plain-return-conditional-expression" }, async (event, step) => {
        return event.payload.ready ? { ready: true } : { ready: false };
      });`,
    );
    const terminal = snapshot.graph.nodes.find(
      (node): node is TerminalNode =>
        node.kind === "terminal" && node.terminalType === "final-return",
    );

    expect(snapshot.graph.nodes.filter((node) => node.kind === "condition")).toEqual([]);
    expect(terminal).toMatchObject({
      order: 0,
      value: "event.payload.ready ? { ready: true } : { ready: false }",
    });
  });

  it("does not discover optional-chained methods named defineWorkflow", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/library-call.js",
      `workflowTools?.defineWorkflow({ name: "library-call" }, async (event, step) => {
        await step.do("not a workflow step", async () => {});
      });`,
    );

    expect(snapshot.graph.nodes).toEqual([]);
    expect(snapshot.graph.edges).toEqual([]);
  });

  it("does not treat strings nested in dynamic step labels as static labels", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/dynamic-label.workflow.js",
      `defineWorkflow({ name: "dynamic-label" }, async (event, step) => {
        await step.do(prefix + "suffix", async () => {});
      });`,
    );
    const step = snapshot.graph.nodes.find((node): node is StepNode => node.kind === "step");

    expect(step).toMatchObject({
      label: "do step",
      construction: { status: "complete", phase: "complete" },
    });
  });

  it("surfaces stable partial workflow and step nodes from unfinished source", () => {
    const source = `defineWorkflow({ name: "draft" }, async (event, step) => {
      await step.do("send reply`;
    const machine = createWorkflowTokenMachine({ path: "automations/draft.workflow.js" });
    let workflowId: string | undefined;
    let stepId: string | undefined;

    for (const token of tokenizeWorkflowSource(source)) {
      const { graph } = machine.push(token);
      const workflow = graph.nodes.find((node): node is WorkflowNode => node.kind === "workflow");
      const step = graph.nodes.find((node): node is StepNode => node.kind === "step");
      if (workflow) {
        workflowId ??= workflow.id;
        assert(workflow.id === workflowId);
      }
      if (step) {
        stepId ??= step.id;
        assert(step.id === stepId);
      }
    }

    const snapshot = machine.snapshot();
    const workflow = snapshot.graph.nodes.find(
      (node): node is WorkflowNode => node.kind === "workflow",
    );
    const step = snapshot.graph.nodes.find((node): node is StepNode => node.kind === "step");

    expect(workflow).toMatchObject({
      id: workflowId,
      name: "draft",
      construction: { status: "partial", phase: "body" },
    });
    expect(step).toMatchObject({
      id: stepId,
      label: "send reply",
      stepType: "do",
      construction: { status: "partial", phase: "labeled" },
    });
    assert(snapshot.state.openToken?.type === "StringLiteral");
    assertUsableGraph(snapshot.graph.nodes, snapshot.graph.edges);
  });

  it("materializes and publishes a token batch once", () => {
    const machine = createWorkflowTokenMachine({ path: "automations/batched.workflow.js" });
    const publishedPatches: GraphPatch[] = [];
    const unsubscribe = machine.onPatch((patch) => {
      if (patch.type !== "reset") {
        publishedPatches.push(patch);
      }
    });

    const update = machine.pushAll(
      tokenizeWorkflowSource(
        `defineWorkflow({ name: "batched" }, async (event, step) => {
          await step.do("one", async () => {});
          await step.do("two", async () => {});
        });`,
      ),
    );
    unsubscribe();

    expect(publishedPatches).toEqual(update.patches);
    expect(update.graph.nodes.filter((node) => node.kind === "step")).toEqual([
      expect.objectContaining({ label: "one" }),
      expect.objectContaining({ label: "two" }),
    ]);
    expect(update.state).toMatchObject({
      status: "tokenizing",
      sourceLength: machine.source().length,
    });
  });

  it("leaves an empty token batch observable as an unchanged snapshot", () => {
    const machine = createWorkflowTokenMachine({ path: "automations/empty-batch.workflow.js" });
    const publishedPatches: GraphPatch[] = [];
    const unsubscribe = machine.onPatch((patch) => publishedPatches.push(patch));

    const update = machine.pushAll([]);
    unsubscribe();

    expect(update).toEqual({ ...machine.snapshot(), patches: [] });
    expect(publishedPatches).toEqual([{ type: "reset", graph: update.graph }]);
  });

  it("emits graph patches as names and labels become known", () => {
    const machine = createWorkflowTokenMachine({ path: "automations/live.workflow.js" });
    const patches: GraphPatch[] = [];
    const unsubscribe = machine.onPatch((patch) => patches.push(patch));

    machine.pushAll(
      tokenizeWorkflowSource(
        `defineWorkflow({ name: "live" }, async (event, step) => { step.sleep("pause", "3 seconds") })`,
      ),
    );
    unsubscribe();

    expect(patches[0]).toMatchObject({ type: "reset" });
    assert(
      patches.some(
        (patch) =>
          patch.type === "node.upsert" &&
          patch.node.kind === "workflow" &&
          patch.node.name === "live",
      ),
    );
    assert(
      patches.some(
        (patch) =>
          patch.type === "node.upsert" &&
          patch.node.kind === "step" &&
          patch.node.label === "pause" &&
          patch.node.meta.duration === "3 seconds",
      ),
    );
  });

  it("excludes ordinary nested function control flow and shadowed step parameters", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/nested-functions.workflow.js",
      `defineWorkflow({ name: "nested-functions" }, async (event, step) => {
        const mapped = event.payload.items.map((item) => {
          if (!item) return null;
          return item.value;
        });
        const concise = event.payload.items.map((step) => step.do("shadowed arrow", () => 1));
        const captured = event.payload.items.map((item) => step.do("captured arrow", () => item));
        function helper(step) {
          if (step.ready) {
            step.do("shadowed function", () => 2);
          }
          for (const item of event.payload.items) {
            step.do("shadowed loop", () => item);
          }
          Promise.all([step.do("shadowed parallel", () => 3)]);
          throw new Error("helper failed");
        }
        const expression = function (step) {
          return step.do("shadowed expression", () => 3);
        };
        await step.do("workflow step", async () => ({
          mapped,
          concise,
          captured,
          helper,
          expression,
        }));
        return { ok: true };
      });`,
    );

    expect(snapshot.graph.nodes.filter((node): node is StepNode => node.kind === "step")).toEqual([
      expect.objectContaining({ label: "workflow step" }),
    ]);
    expect(
      snapshot.graph.nodes.filter((node): node is TerminalNode => node.kind === "terminal"),
    ).toEqual([expect.objectContaining({ terminalType: "final-return", value: "{ ok: true }" })]);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "condition")).toEqual([]);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "loop")).toEqual([]);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "parallel")).toEqual([]);
  });

  it("keeps control flow in direct durable step callbacks", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/durable-callback.workflow.js",
      `defineWorkflow({ name: "durable-callback" }, async (event, step) => {
        await step.do("outer", async () => {
          if (event.payload.ready) {
            await step.do("inner", async () => {
              return { value: 1 };
            });
          }
          return { value: 2 };
        });
      });`,
    );
    const outer = stepByLabel(snapshot.graph, "outer");
    const inner = stepByLabel(snapshot.graph, "inner");
    const condition = snapshot.graph.nodes.find((node) => node.kind === "condition");

    assert(condition?.kind === "condition");
    assert(inner.parentId === condition.id);
    expect(ancestorLabels(snapshot.graph, inner)).toEqual([
      condition.label,
      outer.label,
      "durable-callback",
    ]);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "terminal")).toEqual([]);
  });

  it("captures explicit and implicit step.do callback return values", () => {
    const source = `defineWorkflow({ name: "workspace-smoke-test" }, async (event, step) => {
      const randomValue = await step.do("generate-random-value", async () => {
        return Math.floor(Math.random() * 100);
      });

      const inputSummary = await step.do("inspect-input", async () => {
        const payload = event.payload;
        return {
          hasPayload: payload !== undefined && payload !== null,
          payloadType: Array.isArray(payload) ? "array" : typeof payload,
        };
      });

      const classification = await step.do("classify-random-value", async () => {
        return randomValue % 2 === 0 ? "even" : "odd";
      });

      let branchResult;
      if (randomValue >= 50) {
        branchResult = await step.do("high-value-branch", async () => ({
          branch: "high",
          threshold: 50,
        }));
      } else {
        branchResult = await step.do("low-value-branch", async () => ({
          branch: "low",
          threshold: 50,
        }));
      }

      const finalSummary = await step.do("assemble-summary", async () => ({
        randomValue,
        classification,
        branch: branchResult.branch,
        input: inputSummary,
      }));

      return {
        workflow: "workspace-smoke-test",
        status: "complete",
        summary: finalSummary,
      };
    })`;
    const snapshot = visualizeWorkflowSource("automations/workspace-smoke-test.ts", source);

    expect(
      snapshot.graph.nodes
        .filter((node): node is StepNode => node.kind === "step")
        .map((step) => ({
          label: step.label,
          returns: step.analysis.returns.map(({ syntax, value }) => ({ syntax, value })),
        })),
    ).toEqual([
      {
        label: "generate-random-value",
        returns: [{ syntax: "explicit", value: "Math.floor(Math.random() * 100)" }],
      },
      {
        label: "inspect-input",
        returns: [
          {
            syntax: "explicit",
            value:
              '{\n          hasPayload: payload !== undefined && payload !== null,\n          payloadType: Array.isArray(payload) ? "array" : typeof payload,\n        }',
          },
        ],
      },
      {
        label: "classify-random-value",
        returns: [
          {
            syntax: "explicit",
            value: 'randomValue % 2 === 0 ? "even" : "odd"',
          },
        ],
      },
      {
        label: "high-value-branch",
        returns: [
          {
            syntax: "implicit",
            value: '({\n          branch: "high",\n          threshold: 50,\n        })',
          },
        ],
      },
      {
        label: "low-value-branch",
        returns: [
          {
            syntax: "implicit",
            value: '({\n          branch: "low",\n          threshold: 50,\n        })',
          },
        ],
      },
      {
        label: "assemble-summary",
        returns: [
          {
            syntax: "implicit",
            value:
              "({\n        randomValue,\n        classification,\n        branch: branchResult.branch,\n        input: inputSummary,\n      })",
          },
        ],
      },
    ]);

    for (const step of snapshot.graph.nodes.filter(
      (node): node is StepNode => node.kind === "step",
    )) {
      for (const stepReturn of step.analysis.returns) {
        expect(source.slice(stepReturn.source.start.offset, stepReturn.source.end.offset)).toBe(
          stepReturn.syntax === "explicit" ? `return ${stepReturn.value};` : stepReturn.value,
        );
        expect(stepReturn.construction).toEqual({ status: "complete", phase: "complete" });
      }
    }
  });

  it("keeps an unfinished concise step return observable", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/partial-step-return.ts",
      `defineWorkflow({ name: "partial-step-return" }, async (event, step) => {
        await step.do("draft", async () => ({ value: event.payload`,
      { finish: false },
    );
    const step = stepByLabel(snapshot.graph, "draft");

    expect(step.analysis.returns).toEqual([
      expect.objectContaining({
        syntax: "implicit",
        value: "({ value: event.payload",
        construction: { status: "partial", phase: "returning" },
      }),
    ]);
  });

  it("keeps returns from nested ordinary callbacks out of step return analysis", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/nested-step-returns.ts",
      `defineWorkflow({ name: "nested-step-returns" }, async (event, step) => {
        await step.do("outer", async () => {
          event.payload.items.map((item) => {
            return item.value;
          });
          return await step.do("inner", async () => ({ ok: true }));
        });
      });`,
    );

    expect(
      snapshot.graph.nodes
        .filter((node): node is StepNode => node.kind === "step")
        .map((step) => ({
          label: step.label,
          returns: step.analysis.returns.map(({ syntax, value }) => ({ syntax, value })),
        })),
    ).toEqual([
      {
        label: "outer",
        returns: [
          {
            syntax: "explicit",
            value: 'await step.do("inner", async () => ({ ok: true }))',
          },
        ],
      },
      {
        label: "inner",
        returns: [{ syntax: "implicit", value: "({ ok: true })" }],
      },
    ]);
  });

  it("does not treat return-named members or properties as explicit step returns", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/return-named-expressions.ts",
      `defineWorkflow({ name: "return-named-expressions" }, async (event, step) => {
        await step.do("member return", async () => iterator.return());
        await step.do("property return", async () => ({ return: 1 }));
      });`,
    );

    expect(
      snapshot.graph.nodes
        .filter((node): node is StepNode => node.kind === "step")
        .map((step) => ({
          label: step.label,
          returns: step.analysis.returns.map(({ syntax, value }) => ({ syntax, value })),
        })),
    ).toEqual([
      {
        label: "member return",
        returns: [{ syntax: "implicit", value: "iterator.return()" }],
      },
      {
        label: "property return",
        returns: [{ syntax: "implicit", value: "({ return: 1 })" }],
      },
    ]);
    expect(
      snapshot.state.activeConstructs.filter((construct) => construct.kind === "return"),
    ).toEqual([]);
  });

  it("keeps returns from nested object and class methods out of step return analysis", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/method-step-returns.ts",
      `defineWorkflow({ name: "method-step-returns" }, async (event, step) => {
        await step.do("method scopes", async () => {
          const helper = {
            run() { return 1; },
            async load() { return 2; },
            ["computed"]() { return 3; },
          };
          class Worker {
            run() { return 4; }
          }
          return helper.run();
        });
      });`,
    );

    expect(stepByLabel(snapshot.graph, "method scopes").analysis.returns).toEqual([
      expect.objectContaining({
        syntax: "explicit",
        value: "helper.run()",
        construction: { status: "complete", phase: "complete" },
      }),
    ]);
  });

  it("applies return ASI consistently to workflows and durable step callbacks", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/return-asi.ts",
      `defineWorkflow({ name: "return-asi" }, async (event, step) => {
        await step.do("ASI step", async () => {
          return
          { ok: true };
        });
        return
        { ok: true };
      });`,
    );

    expect(stepByLabel(snapshot.graph, "ASI step").analysis.returns).toEqual([
      expect.objectContaining({
        syntax: "explicit",
        value: "",
        construction: { status: "complete", phase: "complete" },
      }),
    ]);
    expect(snapshot.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "terminal",
          terminalType: "final-return",
          value: "",
          construction: { status: "complete", phase: "complete" },
        }),
      ]),
    );
    expect(
      snapshot.state.activeConstructs.filter((construct) => construct.kind === "return"),
    ).toEqual([]);
  });

  it("records direct call references in the durable step that executes them", () => {
    const source = `defineWorkflow({ name: "step-invocations" }, async (event, step) => {
      await step.do("outer", async () => {
        await store.get({ key: "before" });
        event.payload.items.map(() => telegram.sendMessage({ text: "not direct" }));
        await step.do("inner", async () => {
          await internal.projectFilesConfigure({ projectId: event.payload.projectId });
        });
        await pi.runTurn({ prompt: "finish" });
      });
    });`;
    const snapshot = visualizeWorkflowSource("automations/step-invocations.workflow.js", source);
    const outer = stepByLabel(snapshot.graph, "outer");
    const inner = stepByLabel(snapshot.graph, "inner");

    expect(invocationLabels(outer)).toEqual(["store.get", "event.payload.items.map", "pi.runTurn"]);
    expect(invocationLabels(inner)).toEqual(["internal.projectFilesConfigure"]);
    expect(
      outer.analysis.invocations.map((invocation) =>
        source.slice(invocation.source.start.offset, invocation.source.end.offset),
      ),
    ).toEqual([
      'store.get({ key: "before" })',
      'event.payload.items.map(() => telegram.sendMessage({ text: "not direct" }))',
      'pi.runTurn({ prompt: "finish" })',
    ]);
    assert(outer.analysis.status === "complete");
    assert(
      outer.analysis.invocations.every(
        (invocation) => invocation.construction.status === "complete",
      ),
    );
  });

  it("does not attribute calls through ordinary nested functions or shadowed providers", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/step-invocation-boundaries.workflow.js",
      `defineWorkflow({ name: "step-invocation-boundaries" }, async (event, step) => {
        const internal = event.payload.internal;
        const org = event.payload.org;
        await step.do("boundaries", async () => {
          await internal.projectFilesConfigure({ projectId: "shadowed" });
          await org.internal.filesSeedExecute({});
          const helper = async () => telegram.sendMessage({ text: "nested" });
          return helper;
        });
      });`,
    );

    expect(invocationLabels(stepByLabel(snapshot.graph, "boundaries"))).toEqual([]);
  });

  it("keeps canonical context-derived provider bindings linkable", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/context-provider-invocations.workflow.js",
      `defineWorkflow({ name: "context-provider-invocations" }, async (event, step) => {
        const org = context.org(event.payload.orgId);
        const project = context.project(event.payload.projectId);
        const user = context.user(event.payload.userId);
        await step.do("scoped providers", async () => {
          await org.internal.filesSeedExecute({});
          await project.internal.projectFilesConfigure({ projectId: event.payload.projectId });
          await user.internal.automationsRoutesSeedStarter({});
        });
      });`,
    );

    expect(invocationLabels(stepByLabel(snapshot.graph, "scoped providers"))).toEqual([
      "org.internal.filesSeedExecute",
      "project.internal.projectFilesConfigure",
      "user.internal.automationsRoutesSeedStarter",
    ]);
  });

  it("keeps an unfinished call reference observable", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/partial-invocation.workflow.js",
      `defineWorkflow({ name: "partial-invocation" }, async (event, step) => {
        await step.do("configure", async () => {
          await internal.projectFilesConfigure({ projectId: event.payload.projectId`,
      { finish: false },
    );
    const step = stepByLabel(snapshot.graph, "configure");

    expect(step.analysis).toMatchObject({
      status: "partial",
      invocations: [
        {
          callee: { root: "internal", path: ["projectFilesConfigure"] },
          construction: { status: "partial", phase: "arguments" },
        },
      ],
    });
  });

  it.each([
    ["empty source", ""],
    ["literal expression", `({ ready: true, attempts: 2 });`],
    [
      "plain async Codemode snippet",
      `async () => {
        const catalog = await events.catalogList({});
        const telegramMessage = await events.catalogGet({
          source: "telegram",
          eventType: "message.received",
        });
        return await internal.hooksGet({ fragment: "automations", hookId });
      };`,
    ],
    [
      "named async function",
      `async function loadCatalog() {
        const catalog = await events.catalogList({});
        return catalog.items;
      }`,
    ],
    [
      "ordinary event handler",
      `export async function handle(request) {
        if (!request.ok) throw new Error("request failed");
        return await request.json();
      }`,
    ],
    [
      "step-shaped method calls",
      `async (step) => {
        await step.do("not a durable workflow step", async () => 1);
        await step.sleep("also not a workflow step", "1 second");
      };`,
    ],
    [
      "nested return and throw statements",
      `async (input) => {
        if (!input) throw new Error("missing input");
        if (input.skip) return { skipped: true, reason: "skip" };
        return { accepted: true };
      };`,
    ],
    [
      "workflow syntax in text and comments",
      `const example = "defineWorkflow({ name: 'text' }, handler)";
      // defineWorkflow({ name: "comment" }, async (event, step) => {});
      const docs = \`step.do("documentation only")\`;`,
    ],
    [
      "namespaced method named defineWorkflow",
      `workflowTools.defineWorkflow({ name: "library-method" }, callback);`,
    ],
    [
      "local function declaration named defineWorkflow",
      `function defineWorkflow(options, callback) {
        return { options, callback };
      }`,
    ],
    [
      "constructor named defineWorkflow",
      `const value = new defineWorkflow({ name: "plain-constructor" });`,
    ],
    [
      "incomplete Codemode snippet",
      `async () => {
        const event = await events.catalogGet({ source: "telegram",
      `,
    ],
  ])("does not identify %s as a workflow", (_name, source) => {
    const machine = createWorkflowTokenMachine({ path: "inline-codemode.js" });

    for (const token of tokenizeWorkflowSource(source)) {
      const update = machine.push(token);
      expect(update.graph.nodes).toEqual([]);
      expect(update.graph.edges).toEqual([]);
    }

    const snapshot = machine.finish();
    expect(snapshot.graph).toEqual({ version: 4, nodes: [], edges: [], diagnostics: [] });
    expect(snapshot.state).toMatchObject({ status: "finished", activeConstructs: [] });
    assert(renderWorkflowVisualizationText(snapshot) === "(no workflows)");
  });

  it("keeps invalid Unicode code-point escapes usable", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/invalid-unicode.workflow.js",
      `defineWorkflow({ name: "\\u{110000}" }, async (event, step) => {
        await step.do("still visible", async () => {});
      });`,
    );

    expect(snapshot.graph.nodes).toEqual([
      expect.objectContaining({ kind: "workflow" }),
      expect.objectContaining({ kind: "step", label: "still visible" }),
    ]);
  });

  it("returns useful output for invalid and incomplete input instead of throwing", () => {
    const snapshot = visualizeWorkflowSource(
      "automations/broken.workflow.js",
      `defineWorkflow({ name: "broken" }, async (event, step) => {
        step.waitForEvent("approval", { type: "approved", timeout: "1 day" });
        const value = @
      `,
    );

    expect(snapshot.graph.nodes.filter((node) => node.kind === "workflow")).toHaveLength(1);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "step")).toHaveLength(1);
    expect(snapshot.graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "invalid-token",
    );
    expect(snapshot.graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "incomplete-workflow",
    );
  });
});

function visualizeFixture(path: string) {
  const source = AUTOMATIONS.get(path);
  assert(source !== undefined);
  return visualizeWorkflowSource(path, source);
}

function stepByLabel(graph: WorkflowGraph, label: string): StepNode {
  const step = graph.nodes.find(
    (node): node is StepNode => node.kind === "step" && node.label === label,
  );
  assert(step);
  return step;
}

function invocationLabels(step: StepNode): string[] {
  return step.analysis.invocations.map((invocation) =>
    [invocation.callee.root, ...invocation.callee.path].join("."),
  );
}

function ancestorLabels(graph: WorkflowGraph, node: GraphNode): string[] {
  const nodesById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const labels: string[] = [];
  let current = node;
  while (current.kind !== "workflow") {
    const parent = nodesById.get(current.parentId);
    assert(parent);
    labels.push(parent.label);
    current = parent;
  }
  return labels;
}

function assertUsableGraph(nodes: GraphNode[], edges: Array<{ from: string; to: string }>): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  assert(nodeIds.size === nodes.length);
  for (const edge of edges) {
    assert(nodeIds.has(edge.from));
    assert(nodeIds.has(edge.to));
  }
  for (const node of nodes) {
    if (node.kind !== "workflow") {
      assert(nodeIds.has(node.parentId));
    }
  }
}
