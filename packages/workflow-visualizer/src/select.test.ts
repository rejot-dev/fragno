import { describe, expect, it, assert } from "vitest";

import {
  DEFAULT_EVENT_CATALOG,
  TELEGRAM_TEST_COMMAND,
  TELEGRAM_USER_LINKING,
  TELEGRAM_USER_PI_LINKING,
  WORKSPACE_ROUTER,
} from "./__fixtures__/default-automations.ts";
import { createInterpreter } from "./interpreter.ts";
import { listWorkflows, selectWorkflow } from "./select.ts";

function workspaceGraph() {
  const interp = createInterpreter();
  interp.setEventCatalog(DEFAULT_EVENT_CATALOG);
  interp.updateFile("workspace/automations/router.cm.js", WORKSPACE_ROUTER);
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
    // guard + sleep + do
    assert(testCommand?.stepCount === 3);
    assert(!testCommand?.remote);
  });
});

describe("selectWorkflow", () => {
  it("keeps only the target workflow, its steps, and its triggers", () => {
    const focused = selectWorkflow(workspaceGraph(), "telegram-test-command");

    const workflows = focused.nodes.filter((n) => n.kind === "workflow");
    expect(workflows.map((w) => w.id)).toEqual(["workflow:telegram-test-command"]);

    // none of the other workflows' steps leak in
    const steps = focused.nodes.filter((n) => n.kind === "step");
    assert(steps.every((s) => s.kind === "step" && s.workflowName === "telegram-test-command"));
    expect(steps).toHaveLength(3);

    // the router rule that spawns it is included on the input side
    const routers = focused.nodes.filter((n) => n.kind === "router");
    assert(
      routers.some((r) => r.kind === "router" && r.targetWorkflowName === "telegram-test-command"),
    );
    assert(
      routers.every((r) => r.kind === "router" && r.targetWorkflowName === "telegram-test-command"),
    );

    // the matching event flows in
    assert(focused.nodes.some((n) => n.id === "event:telegram/message.received"));
  });

  it("includes the sendEvent resumer for a workflow that waits", () => {
    const focused = selectWorkflow(workspaceGraph(), "telegram-user-linking");
    assert(
      focused.edges.some((e) => e.type === "sends" && e.to === "workflow:telegram-user-linking"),
    );
    // a sibling workflow's spawn rule must not appear
    const routers = focused.nodes.filter((n) => n.kind === "router");
    assert(
      !routers.some((r) => r.kind === "router" && r.targetWorkflowName === "telegram-test-command"),
    );
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

  it("surfaces a dangling-spawn warning even when focused on an unrelated workflow", () => {
    // The router still spawns telegram-test-command, but its definition is gone.
    const interp = createInterpreter();
    interp.setEventCatalog(DEFAULT_EVENT_CATALOG);
    interp.updateFile("workspace/automations/router.cm.js", WORKSPACE_ROUTER);
    interp.updateFile(
      "workspace/automations/telegram-user-linking.workflow.js",
      TELEGRAM_USER_LINKING,
    );
    interp.updateFile(
      "workspace/automations/telegram-user-pi-linking.workflow.js",
      TELEGRAM_USER_PI_LINKING,
    );
    const full = interp.snapshot();

    // Focusing on a *different*, perfectly valid workflow must still report the
    // dangling spawn — the undefined workflow can't be focused (it has no node).
    const focused = selectWorkflow(full, "telegram-user-linking");
    const diag = focused.diagnostics.find((d) => d.code === "unknown-workflow");
    assert(diag?.message.includes("telegram-test-command"));
  });

  it("keeps the parse error when the focused workflow fails to parse", () => {
    const interp = createInterpreter();
    interp.setEventCatalog(DEFAULT_EVENT_CATALOG);
    interp.updateFile("workspace/automations/router.cm.js", WORKSPACE_ROUTER);
    // A broken body for the focused workflow: unterminated string / stray brace.
    interp.updateFile(
      "workspace/automations/telegram-test-command.workflow.js",
      `defineWorkflow({ name: "telegram-test-command" }, async (event, step) => { @@@ `,
    );
    const full = interp.snapshot();

    const focused = selectWorkflow(full, "telegram-test-command");
    // Whether or not babel recovers the node, the error must reach the view.
    assert(focused.diagnostics.some((d) => d.severity === "error"));
  });
});
