/*
 * Server-only: turns one automation workflow source file into a serializable graph.
 * The old file-router graph parsed every automation source to discover routing
 * edges; routing now lives in automation_route rows, so this module keeps the
 * workbench focused on the selected workflow file instead of building a stale
 * workspace-wide graph.
 */

import type { RouterContextProvider } from "react-router";

import {
  createInterpreter,
  listWorkflows,
  selectWorkflow,
  workflowNodeId,
  type GraphNode,
  type WorkflowGraph,
  type WorkflowInputField,
  type WorkflowInputFieldType,
  type WorkflowSummary,
} from "@fragno-dev/workflow-visualizer";

import type { AutomationEventPayload } from "@/fragno/automation/contracts";
import {
  AUTOMATION_CODEMODE_WORKFLOW,
  createAutomationCodemodeWorkflowInstanceInput,
  createManualAutomationEvent,
  sanitizeWorkflowInstanceId,
} from "@/fragno/automation/engine/workflow-start";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { JsonSchemaObject } from "@/lib/zod/zod-formatter";
import type { AutomationScriptRecord } from "@/routes/backoffice/automations/data";
import {
  loadAutomationScriptSource,
  loadAutomationWorkspaceData,
} from "@/routes/backoffice/automations/data.server";
import { getAutomationsDurableObject } from "@/worker-runtime/durable-objects";

/** Edited script bodies keyed by absolute path. */
export type ScriptOverrides = Map<string, string>;

/** The editable source backing the focused workflow's `defineWorkflow(...)`. */
export type WorkflowSource = {
  absolutePath: string;
  path: string;
  engine: "bash" | "codemode";
  body: string;
  readOnly: boolean;
  inputFields: WorkflowInputField[];
};

function isWorkflowNode(node: GraphNode): node is Extract<GraphNode, { kind: "workflow" }> {
  return node.kind === "workflow";
}

function isWorkflowScript(script: AutomationScriptRecord): boolean {
  return script.path.endsWith(".workflow.js");
}

function workflowNameFromScriptPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.workflow\.js$/, "");
}

function buildWorkflowGraphFromSource(script: AutomationScriptRecord, body: string): WorkflowGraph {
  const interp = createInterpreter();
  interp.updateFile(script.absolutePath, body, {
    kind: "workflow",
    engine: script.engine,
    enabled: true,
  });
  return interp.snapshot();
}

function selectParsedWorkflow(graph: WorkflowGraph, fallbackName: string): string {
  if (
    graph.nodes.some((node) => isWorkflowNode(node) && node.id === workflowNodeId(fallbackName))
  ) {
    return fallbackName;
  }
  return graph.nodes.find(isWorkflowNode)?.name ?? fallbackName;
}

function workflowInputFields(graph: WorkflowGraph, workflowName: string): WorkflowInputField[] {
  return (
    graph.nodes.find(
      (node): node is Extract<GraphNode, { kind: "workflow" }> =>
        isWorkflowNode(node) && node.id === workflowNodeId(workflowName),
    )?.inputSchema ?? []
  );
}

export type RunnableEvent = {
  source: string;
  eventType: string;
  label: string;
  fields: WorkflowInputField[];
};

export type WorkflowListEntry = WorkflowSummary & { broken?: boolean };

export type WorkflowGraphView = {
  workflows: WorkflowListEntry[];
  selected: string | null;
  graph: WorkflowGraph;
  source: WorkflowSource | null;
  events: RunnableEvent[];
};

const JSON_TYPE_MAP: Record<string, WorkflowInputFieldType> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
};

function jsonSchemaPropToField(
  name: string,
  prop: JsonSchemaObject,
  optional: boolean,
): WorkflowInputField {
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum.filter((v): v is string => typeof v === "string")
    : undefined;
  const isEnum = enumValues?.length === (prop.enum?.length ?? 0);

  let type: WorkflowInputFieldType = "unknown";
  if (isEnum && enumValues && enumValues.length > 0) {
    type = "enum";
  } else {
    const single = Array.isArray(prop.type) ? prop.type.find((t) => t !== "null") : prop.type;
    type = (single && JSON_TYPE_MAP[single]) || "unknown";
  }

  return {
    name,
    type,
    optional,
    ...(type === "enum" && enumValues ? { enumValues } : {}),
    ...(prop.description ? { description: prop.description } : {}),
  };
}

function jsonSchemaToFields(schema: JsonSchemaObject | undefined): WorkflowInputField[] {
  const properties = schema?.properties;
  if (!properties) {
    return [];
  }
  const required = new Set(schema?.required ?? []);
  return Object.entries(properties).map(([name, prop]) =>
    jsonSchemaPropToField(name, prop, !required.has(name)),
  );
}

function buildRunnableEvents(): RunnableEvent[] {
  return listAutomationEventDescriptors().map((descriptor) => ({
    source: descriptor.source,
    eventType: descriptor.eventType,
    label: descriptor.label,
    fields: jsonSchemaToFields(descriptor.payloadSchema as JsonSchemaObject | undefined),
  }));
}

const EMPTY_GRAPH: WorkflowGraph = {
  version: 1,
  nodes: [],
  edges: [],
  diagnostics: [],
};

async function loadWorkflowScripts({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}) {
  const { scripts } = await loadAutomationWorkspaceData({ request, context, orgId });
  return scripts
    .filter((script) => script.layer === "workspace" && isWorkflowScript(script))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export async function buildWorkflowGraphView({
  request,
  context,
  orgId,
  workflowName,
  overrides,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  workflowName?: string;
  overrides?: ScriptOverrides;
}): Promise<WorkflowGraphView> {
  const scripts = await loadWorkflowScripts({ request, context, orgId });
  const workflows = scripts.map((script) => {
    const name = workflowNameFromScriptPath(script.path);
    return { name, label: name, remote: false, stepCount: 0 } satisfies WorkflowListEntry;
  });
  const selected =
    workflowName && workflows.some((w) => w.name === workflowName)
      ? workflowName
      : (workflows[0]?.name ?? null);

  if (!selected) {
    return { workflows: [], selected: null, graph: EMPTY_GRAPH, source: null, events: [] };
  }

  const script = scripts.find((entry) => workflowNameFromScriptPath(entry.path) === selected);
  if (!script) {
    return { workflows, selected: null, graph: EMPTY_GRAPH, source: null, events: [] };
  }

  const sourceResult = await loadAutomationScriptSource({
    request,
    context,
    orgId,
    scriptId: script.id,
  });
  const body = overrides?.get(script.absolutePath) ?? sourceResult.script ?? "";
  const full = sourceResult.scriptError
    ? {
        ...EMPTY_GRAPH,
        diagnostics: [{ severity: "error" as const, message: sourceResult.scriptError }],
      }
    : buildWorkflowGraphFromSource(script, body);
  const parsedWorkflowName = selectParsedWorkflow(full, selected);
  const graph = selectWorkflow(full, parsedWorkflowName);
  const parsed = listWorkflows(full);
  const stepCount = parsed.find((entry) => entry.name === parsedWorkflowName)?.stepCount ?? 0;
  const nextWorkflows = workflows.map((entry) =>
    entry.name === selected
      ? { ...entry, stepCount, broken: !full.nodes.some(isWorkflowNode) || undefined }
      : entry,
  );

  return {
    workflows: nextWorkflows,
    selected,
    graph,
    source: {
      absolutePath: script.absolutePath,
      path: script.path,
      engine: script.engine,
      body,
      readOnly: script.readOnly,
      inputFields: workflowInputFields(full, parsedWorkflowName),
    },
    events: buildRunnableEvents(),
  };
}

export async function previewWorkflowGraph({
  request,
  context,
  orgId,
  workflowName,
  absolutePath,
  body,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  workflowName: string;
  absolutePath: string;
  body: string;
}): Promise<{ graph: WorkflowGraph }> {
  const scripts = await loadWorkflowScripts({ request, context, orgId });
  const script = scripts.find((entry) => entry.absolutePath === absolutePath);
  if (!script) {
    return { graph: EMPTY_GRAPH };
  }

  const full = buildWorkflowGraphFromSource(script, body);
  return { graph: selectWorkflow(full, selectParsedWorkflow(full, workflowName)) };
}

export async function runWorkflow({
  request,
  context,
  orgId,
  workflowName,
  source,
  eventType,
  payload,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  workflowName: string;
  source: string;
  eventType: string;
  payload: AutomationEventPayload;
}): Promise<
  { ok: true; instanceId: string; runWorkflowName: string } | { ok: false; error: string }
> {
  const view = await buildWorkflowGraphView({
    request,
    context,
    orgId,
    workflowName,
  });
  if (!view.source || view.selected !== workflowName) {
    return {
      ok: false,
      error: `Workflow "${workflowName}" not found in this workspace.`,
    };
  }

  const instanceId = sanitizeWorkflowInstanceId(`run-${orgId}-${crypto.randomUUID()}`);
  const automationEvent = createManualAutomationEvent({
    orgId,
    source,
    eventType,
    payload,
    id: instanceId,
  });
  const workflowInput = createAutomationCodemodeWorkflowInstanceInput({
    event: automationEvent,
    workflowScriptPath: view.source.absolutePath,
    instanceId,
    remoteWorkflowName: AUTOMATION_CODEMODE_WORKFLOW,
  });

  try {
    const runtime = createRouteBackedAutomationWorkflowRuntime({
      object: getAutomationsDurableObject(context, orgId),
      scope: { kind: "org", orgId },
    });
    const created = await runtime.createInstance(workflowInput);
    return {
      ok: true,
      instanceId: created.instanceId,
      runWorkflowName: AUTOMATION_CODEMODE_WORKFLOW,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
