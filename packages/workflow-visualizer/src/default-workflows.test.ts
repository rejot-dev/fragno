import { describe, expect, it, assert } from "vitest";

import {
  CODEMODE_TYPES_REFRESH,
  DEFAULT_EVENT_CATALOG,
  SYSTEM_ROUTER,
  TELEGRAM_TEST_COMMAND,
  TELEGRAM_USER_LINKING,
  TELEGRAM_USER_PI_LINKING,
  WORKSPACE_FILE_INITIALIZATION,
  WORKSPACE_ROUTER,
} from "./__fixtures__/default-automations.ts";
import { createInterpreter, type Interpreter } from "./interpreter.ts";
import type { RouterNode, StepNode, WorkflowNode } from "./model.ts";

function workflows(interp: Interpreter): WorkflowNode[] {
  return interp.snapshot().nodes.filter((n): n is WorkflowNode => n.kind === "workflow");
}

function stepsOf(interp: Interpreter, workflowName: string): StepNode[] {
  return interp
    .snapshot()
    .nodes.filter((n): n is StepNode => n.kind === "step" && n.workflowName === workflowName)
    .sort((a, b) => a.order - b.order);
}

function routers(interp: Interpreter): RouterNode[] {
  return interp.snapshot().nodes.filter((n): n is RouterNode => n.kind === "router");
}

function loadSystemDefaults(): Interpreter {
  const interp = createInterpreter();
  interp.setEventCatalog(DEFAULT_EVENT_CATALOG);
  interp.updateFile("system/automations/router.cm.js", SYSTEM_ROUTER);
  interp.updateFile(
    "system/automations/workspace-file-initialization.workflow.js",
    WORKSPACE_FILE_INITIALIZATION,
  );
  interp.updateFile(
    "system/automations/codemode-types-refresh.workflow.js",
    CODEMODE_TYPES_REFRESH,
  );
  return interp;
}

function loadWorkspaceDefaults(): Interpreter {
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
  return interp;
}

describe("system default automations", () => {
  it("parses the shipped defaults without errors or warnings", () => {
    const diagnostics = loadSystemDefaults().snapshot().diagnostics;
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(diagnostics.filter((d) => d.severity === "warning")).toEqual([]);
  });

  it("discovers both workflows as local (non-remote)", () => {
    const names = workflows(loadSystemDefaults())
      .map((w) => w.name)
      .sort();
    expect(names).toEqual(["codemode-types-refresh", "workspace-file-initialization"]);
    assert(workflows(loadSystemDefaults()).every((w) => !w.remote));
  });

  it("extracts workspace-file-initialization steps in source order", () => {
    const steps = stepsOf(loadSystemDefaults(), "workspace-file-initialization");
    expect(steps.map((s) => s.label)).toEqual([
      "not-organization-created",
      "configure upload database connection",
      "seed workspace starter files",
      "write codemode dts",
    ]);
    // the leading guard is the early return; the rest are `do` steps that run
    // unconditionally after it
    assert(steps[0]?.stepType === "guard");
    assert(
      steps[0]?.meta.condition ===
        'automationEvent.source !== "auth" ||\n      automationEvent.eventType !== "organization.created"',
    );
    assert(steps.every((s) => s.branch.length === 0));
    assert(steps.slice(1).every((s) => s.stepType === "do"));
  });

  it("extracts the single step in a `return await step.do(...)` workflow", () => {
    const steps = stepsOf(loadSystemDefaults(), "codemode-types-refresh");
    expect(steps).toHaveLength(1);
    assert(steps[0]?.label === "sync codemode dts");
  });

  it("routes auth/organization.created -> workspace-file-initialization", () => {
    const interp = loadSystemDefaults();
    const spawn = routers(interp).find(
      (r) => r.targetWorkflowName === "workspace-file-initialization",
    );
    assert(spawn?.match.source === "auth");
    assert(spawn?.match.eventType === "organization.created");

    const graph = interp.snapshot();
    assert(
      graph.edges.some(
        (e) =>
          e.type === "matches" &&
          e.from === "event:auth/organization.created" &&
          e.to === spawn?.id,
      ),
    );
    assert(
      graph.edges.some(
        (e) => e.type === "spawns" && e.to === "workflow:workspace-file-initialization",
      ),
    );
  });

  it("routes the codemode-types-refresh spawn even though its guard is a hoisted variable", () => {
    const interp = loadSystemDefaults();
    const spawn = routers(interp).find((r) => r.targetWorkflowName === "codemode-types-refresh");
    expect(spawn).toBeDefined();
    // the guard is `if (shouldRefreshCodemodeTypes)`, so no inline source/eventType is extractable
    expect(spawn?.match.source).toBeUndefined();
    assert(
      interp
        .snapshot()
        .edges.some((e) => e.type === "spawns" && e.to === "workflow:codemode-types-refresh"),
    );
  });
});

describe("workspace (telegram) default automations", () => {
  it("parses the shipped defaults without errors or warnings", () => {
    const diagnostics = loadWorkspaceDefaults().snapshot().diagnostics;
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(diagnostics.filter((d) => d.severity === "warning")).toEqual([]);
  });

  it("annotates the conditionally-run step with its enclosing guard", () => {
    const steps = stepsOf(loadWorkspaceDefaults(), "telegram-user-linking");
    const alreadyLinked = steps.find((s) => s.label === "send already linked telegram message");
    expect(alreadyLinked?.branch).toEqual(["linkedUser?.value"]);
    // it sits after the leading guard and the lookup step, in source order
    assert(alreadyLinked?.order === 2);
  });

  it("captures waitForEvent type and timeout metadata", () => {
    const steps = stepsOf(loadWorkspaceDefaults(), "telegram-user-linking");
    const wait = steps.find((s) => s.stepType === "waitForEvent");
    assert(wait?.meta.eventType === "identity-claim-completed");
    assert(wait?.meta.timeout === "15 minutes");
  });

  it("captures sleep duration metadata", () => {
    const steps = stepsOf(loadWorkspaceDefaults(), "telegram-test-command");
    expect(
      steps.map((s) => ({ type: s.stepType, label: s.label, duration: s.meta.duration })),
    ).toEqual([
      { type: "guard", label: "not-test-command", duration: undefined },
      { type: "sleep", label: "wait 3 seconds", duration: "3 seconds" },
      { type: "do", label: "send delayed test reply", duration: undefined },
    ]);
  });

  it("wires router.sendEvent(identity-claim-completed) to the workflow that waits for it", () => {
    const interp = loadWorkspaceDefaults();
    const sends = interp.snapshot().edges.find((e) => e.type === "sends");
    assert(sends?.to === "workflow:telegram-user-linking");
    assert(sends?.label === "identity-claim-completed");
  });

  it("emits a spawn rule for each telegram command branch", () => {
    const targets = routers(loadWorkspaceDefaults())
      .filter((r) => r.action === "spawn")
      .map((r) => r.targetWorkflowName)
      .sort();
    expect(targets).toEqual([
      "telegram-test-command",
      "telegram-user-linking",
      "telegram-user-pi-linking",
    ]);
  });

  it("annotates pi-session steps nested under the reuse guard", () => {
    const steps = stepsOf(loadWorkspaceDefaults(), "telegram-user-pi-linking");
    const guarded = steps.filter((s) => s.branch.includes("!reusableSession.reusable"));
    expect(guarded.map((s) => s.label)).toEqual(["create pi session", "store pi session binding"]);
    // top-level lookups run unconditionally
    expect(steps.find((s) => s.label === "lookup linked telegram user")?.branch).toEqual([]);
  });

  it("carries the nested command match onto each telegram spawn rule", () => {
    const startSpawn = routers(loadWorkspaceDefaults()).find(
      (r) => r.targetWorkflowName === "telegram-user-linking",
    );
    assert(startSpawn?.match.source === "telegram");
    assert(startSpawn?.match.eventType === "message.received");
    // the innermost guard text is preserved in the condition trail
    assert(startSpawn?.match.conditions.some((c) => c.includes('text === "/start"')));
  });
});
