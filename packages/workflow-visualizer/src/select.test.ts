import { describe, expect, it, assert } from "vitest";

import {
  TELEGRAM_TEST_COMMAND,
  TELEGRAM_USER_LINKING,
  TELEGRAM_USER_PI_LINKING,
} from "./__fixtures__/default-automations.ts";
import { createInterpreter } from "./interpreter.ts";
import { listWorkflows, selectWorkflow } from "./select.ts";

function workspaceGraph() {
  const interp = createInterpreter();
  interp.updateFile(
    "workspace/automations/telegram-user-linking.workflow.js",
    TELEGRAM_USER_LINKING,
  );
  interp.updateFile(
    "workspace/automations/telegram-test-command.workflow.js",
    TELEGRAM_TEST_COMMAND,
  );
  interp.updateFile(
    "workspace/automations/telegram-user-pi-linking.workflow.js",
    TELEGRAM_USER_PI_LINKING,
  );
  return interp.snapshot();
}

describe("listWorkflows", () => {
  it("summarizes every workflow with its step count, sorted by label", () => {
    const summaries = listWorkflows(workspaceGraph());
    expect(summaries.map((s) => s.name)).toEqual([
      "telegram-test-command",
      "telegram-user-linking",
      "telegram-user-pi-linking",
    ]);
    const testCommand = summaries.find((s) => s.name === "telegram-test-command");
    assert(testCommand?.stepCount === 3);
    assert(!testCommand?.remote);
  });
});

describe("selectWorkflow", () => {
  it("keeps only the target workflow and its steps", () => {
    const focused = selectWorkflow(workspaceGraph(), "telegram-test-command");

    const workflows = focused.nodes.filter((n) => n.kind === "workflow");
    expect(workflows.map((w) => w.id)).toEqual(["workflow:telegram-test-command"]);

    const steps = focused.nodes.filter((n) => n.kind === "step");
    assert(steps.every((s) => s.kind === "step" && s.workflowName === "telegram-test-command"));
    expect(steps).toHaveLength(3);
  });

  it("only keeps edges whose endpoints both survive", () => {
    const focused = selectWorkflow(workspaceGraph(), "telegram-test-command");
    const ids = new Set(focused.nodes.map((n) => n.id));
    assert(focused.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  });

  it("returns an empty graph for an unknown workflow", () => {
    const focused = selectWorkflow(workspaceGraph(), "does-not-exist");
    expect(focused.nodes).toEqual([]);
    expect(focused.edges).toEqual([]);
  });

  it("keeps the parse error when the focused workflow fails to parse", () => {
    const interp = createInterpreter();
    interp.updateFile(
      "workspace/automations/telegram-test-command.workflow.js",
      `defineWorkflow({ name: "telegram-test-command" }, async (event, step) => { @@@ `,
    );
    const focused = selectWorkflow(interp.snapshot(), "telegram-test-command");
    assert(focused.diagnostics.some((d) => d.severity === "error"));
  });
});
