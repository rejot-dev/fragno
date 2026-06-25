/*
 * Authoring helpers for automation scripts, operating directly on an
 * `IFileSystem` (no route request needed) so the Pi agent can author, validate,
 * and run automations the same way the cadence workbench does.
 *
 * Scripts live under `/workspace/automations/*` on the same Backoffice
 * filesystem the Pi session already mounts. Validation reuses the
 * `@fragno-dev/workflow-visualizer` interpreter: it parses the whole catalog
 * (so cross-file references resolve), with the script under authoring overridden
 * in place, and returns the same diagnostics the workbench surfaces.
 */

import {
  createInterpreter,
  type Diagnostic,
  type GraphNode,
  type WorkflowGraph,
} from "@fragno-dev/workflow-visualizer";

import type { IFileSystem } from "@/files/interface";
import {
  AUTOMATION_SYSTEM_ROOT,
  inferWorkspaceScriptEngine,
  loadAutomationCatalog,
  normalizeScriptRelativePath,
  toAbsoluteAutomationPath,
  type AutomationCatalog,
  type AutomationScriptEngine,
} from "@/fragno/automation/catalog";
import {
  AUTOMATION_SYSTEM_ACTOR,
  type AutomationEvent,
  type AutomationEventPayload,
} from "@/fragno/automation/contracts";
import type { AutomationCodemodeWorkflowParams } from "@/fragno/automation/engine/workflow";
import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { AutomationWorkflowRuntime } from "@/fragno/runtime-tools/families/automations-workflow";

/**
 * The registered remote workflow that runs any codemode automation script by
 * path (`defineAutomationCodemodeWorkflow`). A manual run invokes it directly
 * with the authored script's path, bypassing the router.
 */
export const AUTOMATION_CODEMODE_WORKFLOW = "automation-codemode-script";

export type AutomationDiagnostic = {
  severity: Diagnostic["severity"];
  message: string;
  /** File the diagnostic points at, as passed to the interpreter (absolute). */
  path?: string;
  line?: number;
};

export type AuthoredWorkflowSummary = {
  name: string;
  stepCount: number;
  /** Step labels in source order, for a quick at-a-glance shape. */
  steps: string[];
};

export type AutomationScriptSummary = {
  /** Workspace-relative path (e.g. `router.cm.js`). */
  path: string;
  absolutePath: string;
  engine: AutomationScriptEngine;
  kind: "router" | "workflow" | "script";
  /** True for system-layer scripts, which cannot be written. */
  readOnly: boolean;
  /** Workflows defined in this file (empty for routers / plain scripts). */
  workflows: AuthoredWorkflowSummary[];
};

export type AutomationValidation = {
  path: string;
  absolutePath: string;
  engine: AutomationScriptEngine;
  /** True when no error diagnostics are attributable to this file. */
  ok: boolean;
  diagnostics: AutomationDiagnostic[];
  summary: AutomationScriptSummary;
};

const isSystemPath = (absolutePath: string) =>
  absolutePath === AUTOMATION_SYSTEM_ROOT || absolutePath.startsWith(`${AUTOMATION_SYSTEM_ROOT}/`);

const isWorkflowNode = (node: GraphNode): node is Extract<GraphNode, { kind: "workflow" }> =>
  node.kind === "workflow";

const isStepNode = (node: GraphNode): node is Extract<GraphNode, { kind: "step" }> =>
  node.kind === "step";

const toAutomationDiagnostic = (diagnostic: Diagnostic): AutomationDiagnostic => ({
  severity: diagnostic.severity,
  message: diagnostic.message,
  ...(diagnostic.ref?.path ? { path: diagnostic.ref.path } : {}),
  ...(diagnostic.ref?.line ? { line: diagnostic.ref.line } : {}),
});

type ScriptOverride = {
  absolutePath: string;
  body: string;
  engine: AutomationScriptEngine;
  enabled: boolean;
};

/** Parse the full catalog into a graph, optionally overriding one file's body. */
const buildGraph = (catalog: AutomationCatalog, override?: ScriptOverride): WorkflowGraph => {
  const interp = createInterpreter();
  interp.setEventCatalog(
    listAutomationEventDescriptors().map((event) => ({
      source: event.source,
      eventType: event.eventType,
      label: event.label,
      description: event.description,
    })),
  );

  let overrideApplied = false;
  for (const script of catalog.scripts) {
    const isTarget = override !== undefined && override.absolutePath === script.absolutePath;
    if (isTarget) {
      overrideApplied = true;
    }
    interp.updateFile(script.absolutePath, isTarget ? override.body : script.body, {
      engine: isTarget ? override.engine : script.engine,
      enabled: isTarget ? override.enabled : script.enabled,
    });
  }

  // Authoring a brand-new file that isn't in the catalog yet.
  if (override !== undefined && !overrideApplied) {
    interp.updateFile(override.absolutePath, override.body, {
      engine: override.engine,
      enabled: override.enabled,
    });
  }

  return interp.snapshot();
};

const summarizeScript = (
  graph: WorkflowGraph,
  args: { path: string; absolutePath: string; engine: AutomationScriptEngine },
): AutomationScriptSummary => {
  const workflowNodes = graph.nodes
    .filter(isWorkflowNode)
    .filter((node) => node.path === args.absolutePath);

  const workflows = workflowNodes.map((workflow) => {
    const steps = graph.nodes
      .filter(isStepNode)
      .filter((step) => step.workflowName === workflow.name)
      .sort((a, b) => a.order - b.order)
      .map((step) => step.label);
    return { name: workflow.name, stepCount: steps.length, steps };
  });

  const kind: AutomationScriptSummary["kind"] =
    workflowNodes.length > 0
      ? "workflow"
      : args.path.endsWith("router.cm.js")
        ? "router"
        : "script";

  return {
    path: args.path,
    absolutePath: args.absolutePath,
    engine: args.engine,
    kind,
    readOnly: isSystemPath(args.absolutePath),
    workflows,
  };
};

const resolveWorkspacePath = (path: string) => {
  const relativePath = normalizeScriptRelativePath(path);
  return {
    relativePath,
    absolutePath: toAbsoluteAutomationPath(relativePath),
    engine: inferWorkspaceScriptEngine(relativePath),
    // Workflows are invoked by the router, not enabled directly (matches the catalog).
    enabled: !relativePath.endsWith(".workflow.js"),
  };
};

/** List the authorable automation scripts in the workspace, with their shape. */
export const listAutomationScripts = async (
  fs: IFileSystem,
): Promise<AutomationScriptSummary[]> => {
  const catalog = await loadAutomationCatalog(fs);
  const graph = buildGraph(catalog);
  return catalog.scripts
    .filter((script) => !isSystemPath(script.absolutePath))
    .map((script) =>
      summarizeScript(graph, {
        path: script.path,
        absolutePath: script.absolutePath,
        engine: script.engine,
      }),
    );
};

/** Parse a candidate script body without writing it. */
export const validateAutomationScript = async (
  fs: IFileSystem,
  input: { path: string; body: string },
): Promise<AutomationValidation> => {
  const { relativePath, absolutePath, engine, enabled } = resolveWorkspacePath(input.path);
  const catalog = await loadAutomationCatalog(fs);
  const graph = buildGraph(catalog, { absolutePath, body: input.body, engine, enabled });

  const diagnostics = graph.diagnostics.map(toAutomationDiagnostic);
  // Only this file's own errors block the write — pre-existing errors elsewhere
  // in the catalog must not stop the agent from authoring an unrelated script.
  const blocking = diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      (diagnostic.path === undefined || diagnostic.path === absolutePath),
  );

  return {
    path: relativePath,
    absolutePath,
    engine,
    ok: blocking.length === 0,
    diagnostics,
    summary: summarizeScript(graph, { path: relativePath, absolutePath, engine }),
  };
};

export type AutomationWriteResult =
  | { ok: true; created: boolean; validation: AutomationValidation }
  | { ok: false; error: string; validation?: AutomationValidation };

/**
 * Validate, then write an automation script into the workspace. Refuses to write
 * when the script has error-level diagnostics attributable to it (hard gate), and
 * rejects system-layer paths (read-only).
 */
export const writeAutomationScript = async (
  fs: IFileSystem,
  input: { path: string; body: string },
): Promise<AutomationWriteResult> => {
  const trimmedInput = input.path.trim();
  if (
    trimmedInput === AUTOMATION_SYSTEM_ROOT ||
    trimmedInput.startsWith(`${AUTOMATION_SYSTEM_ROOT}/`)
  ) {
    return { ok: false, error: "System automation scripts are read-only." };
  }

  let validation: AutomationValidation;
  try {
    validation = await validateAutomationScript(fs, input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!validation.ok) {
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    return {
      ok: false,
      error: `Refusing to write ${validation.path}: ${errors.length} error diagnostic(s). Fix them and retry.`,
      validation,
    };
  }

  const { absolutePath } = validation;
  const created = !(await fs.exists(absolutePath));
  const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(absolutePath, input.body);

  return { ok: true, created, validation };
};

export type AutomationRunInput = {
  orgId: string;
  path: string;
  /** Trigger event source (defaults to `manual`). */
  source?: string;
  eventType: string;
  payload?: AutomationEventPayload;
};

export type AutomationRunResult = {
  instanceId: string;
  workflowName: string;
  scriptPath: string;
};

/**
 * Run an authored automation script with a synthetic trigger event, via the
 * generic `automation-codemode-script` remote workflow (bypassing the router).
 */
export const runAutomationScript = async (
  fs: IFileSystem,
  runtime: AutomationWorkflowRuntime,
  input: AutomationRunInput,
): Promise<AutomationRunResult> => {
  const { absolutePath } = resolveWorkspacePath(input.path);
  if (!(await fs.exists(absolutePath))) {
    return Promise.reject(
      new Error(`Automation script not found at ${absolutePath}. Write it first.`),
    );
  }

  const instanceId = `pi-run-${input.orgId}-${crypto.randomUUID()}`.replaceAll(
    /[^A-Za-z0-9_-]/g,
    "-",
  );
  const source = (input.source ?? "manual").trim() || "manual";
  const automationEvent: AutomationEvent = {
    id: instanceId,
    scope: { kind: "org", orgId: input.orgId },
    source,
    eventType: input.eventType,
    occurredAt: new Date().toISOString(),
    payload: input.payload ?? {},
    actor: AUTOMATION_SYSTEM_ACTOR,
    actors: [AUTOMATION_SYSTEM_ACTOR],
    subject: { orgId: input.orgId },
  };
  const params: AutomationCodemodeWorkflowParams = {
    automationEvent,
    workflowScriptPath: absolutePath,
    idempotencyKey: instanceId,
  };

  const created = await runtime.createInstance({
    workflowName: AUTOMATION_CODEMODE_WORKFLOW,
    remoteWorkflowName: AUTOMATION_CODEMODE_WORKFLOW,
    instanceId,
    params,
  });

  return {
    instanceId: created.instanceId,
    workflowName: created.workflowName,
    scriptPath: absolutePath,
  };
};
