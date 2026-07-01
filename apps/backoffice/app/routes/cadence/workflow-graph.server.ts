/*
 * Server-only: turns the org's automation scripts into a serializable pipeline
 * graph using `@fragno-dev/workflow-visualizer`. The visualizer (and its babel
 * parser) only ever runs here, in the loader — never in the browser bundle.
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

import { AUTOMATION_SYSTEM_ROOT } from "@/fragno/automation";
import type { AutomationCatalog } from "@/fragno/automation/catalog";
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
import { loadAutomationCatalogWithSources } from "@/routes/backoffice/automations/data.server";
import { getAutomationsDurableObject } from "@/worker-runtime/durable-objects";

/**
 * Edited script bodies keyed by absolute path. Used to preview the graph for
 * unsaved edits made in the workbench without touching the underlying files.
 */
export type ScriptOverrides = Map<string, string>;

/** Build the full pipeline graph from a catalog, applying any unsaved overrides. */
function buildAutomationGraphFromCatalog(
  catalog: AutomationCatalog,
  overrides?: ScriptOverrides,
): WorkflowGraph {
  const interp = createInterpreter();
  interp.setEventCatalog(
    listAutomationEventDescriptors().map((event) => ({
      source: event.source,
      eventType: event.eventType,
      label: event.label,
      description: event.description,
    })),
  );

  // Key by absolutePath so the system and workspace `router.cm.js` don't collide.
  for (const script of catalog.scripts) {
    const body = overrides?.get(script.absolutePath) ?? script.body;
    interp.updateFile(script.absolutePath, body, {
      engine: script.engine,
      enabled: script.enabled,
    });
  }

  return interp.snapshot();
}

export async function buildAutomationGraph({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<WorkflowGraph> {
  const catalog = await loadAutomationCatalogWithSources({
    request,
    context,
    orgId,
  });
  return buildAutomationGraphFromCatalog(catalog);
}

/** The editable source backing the focused workflow's `defineWorkflow(...)`. */
export type WorkflowSource = {
  /** Absolute FS path of the file holding the workflow definition. */
  absolutePath: string;
  /** Workspace-relative path, for display. */
  path: string;
  engine: "bash" | "codemode";
  /** Current body (reflects unsaved overrides when previewing). */
  body: string;
  /** True for system-layer scripts, which cannot be saved. */
  readOnly: boolean;
  /** Parsed input schema fields, for rendering the run form (empty if none). */
  inputFields: WorkflowInputField[];
};

function isWorkflowNode(node: GraphNode): node is Extract<GraphNode, { kind: "workflow" }> {
  return node.kind === "workflow";
}

/** True for system-layer automation paths (built-in platform plumbing). */
function isSystemLayerPath(path: string): boolean {
  return path === AUTOMATION_SYSTEM_ROOT || path.startsWith(`${AUTOMATION_SYSTEM_ROOT}/`);
}

/** A workspace automation file holding a workflow definition (by convention). */
function isWorkflowScriptPath(path: string): boolean {
  return path.endsWith(".workflow.js");
}

/**
 * The workflow name a `*.workflow.js` file is expected to define — by convention
 * its basename. This is how a file that *failed to parse* (and so produced no
 * workflow node) is still given a stable, selectable name, so the viewer can
 * focus it and show its error rather than falling back to a sibling workflow.
 */
function workflowNameFromScriptPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.workflow\.js$/, "");
}

/**
 * Resolve the editable source for `workflowName`. A parsed workflow resolves via
 * its graph node's file; a workflow file that failed to parse has no node, so it
 * resolves by the naming convention instead — its source still opens in the
 * editor so the syntax error can be fixed in place.
 */
function resolveWorkflowSource(
  catalog: AutomationCatalog,
  graph: WorkflowGraph,
  workflowName: string,
  overrides?: ScriptOverrides,
): WorkflowSource | null {
  const workflowNode = graph.nodes.find(
    (n): n is Extract<GraphNode, { kind: "workflow" }> =>
      isWorkflowNode(n) && n.id === workflowNodeId(workflowName),
  );

  const script = workflowNode
    ? catalog.scripts.find((s) => s.absolutePath === workflowNode.path)
    : catalog.scripts.find(
        (s) => isWorkflowScriptPath(s.path) && workflowNameFromScriptPath(s.path) === workflowName,
      );
  if (!script) {
    return null;
  }

  const readOnly = isSystemLayerPath(script.absolutePath);

  return {
    absolutePath: script.absolutePath,
    path: script.path,
    engine: script.engine,
    body: overrides?.get(script.absolutePath) ?? script.body,
    readOnly,
    inputFields: workflowNode?.inputSchema ?? [],
  };
}

/**
 * A trigger event the focused workflow can be run with, plus the form fields
 * derived from that event's declared payload schema (from the capability catalog).
 */
export type RunnableEvent = {
  source: string;
  eventType: string;
  label: string;
  fields: WorkflowInputField[];
};

/**
 * A workflow as listed in the selector. `broken` marks a workflow file that
 * exists but failed to parse (no graph node): still selectable, so its error is
 * shown in the viewer instead of the file silently vanishing from the list.
 */
export type WorkflowListEntry = WorkflowSummary & { broken?: boolean };

export type WorkflowGraphView = {
  /** Every workflow in the workspace, for the selector. */
  workflows: WorkflowListEntry[];
  /** The workflow currently in focus (null when there are none). */
  selected: string | null;
  /** The focused subgraph for `selected` — input (triggers) → output (steps). */
  graph: WorkflowGraph;
  /** The editable source for `selected` (null when there are none). */
  source: WorkflowSource | null;
  /** Events that trigger `selected`, with payload form fields, for the run form. */
  events: RunnableEvent[];
};

const JSON_TYPE_MAP: Record<string, WorkflowInputFieldType> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
};

/** Convert one JSON-schema property into a coarse form field descriptor. */
function jsonSchemaPropToField(
  name: string,
  prop: JsonSchemaObject,
  optional: boolean,
): WorkflowInputField {
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum.filter((v): v is string => typeof v === "string")
    : undefined;
  const isEnum = enumValues !== undefined && enumValues.length === (prop.enum?.length ?? 0);

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

/** Flatten a JSON-schema object's top-level properties into form fields. */
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

/**
 * The events the focused workflow can be triggered by, each with payload form
 * fields from the capability catalog's declared schema. Falls back to every
 * known event when the workflow's triggers can't be resolved from the graph
 * (e.g. wildcard routers), so the run form is always useful.
 */
function buildRunnableEvents(graph: WorkflowGraph): RunnableEvent[] {
  const descriptors = listAutomationEventDescriptors();
  const byKey = new Map(descriptors.map((d) => [`${d.source}/${d.eventType}`, d]));

  const events: RunnableEvent[] = [];
  const seen = new Set<string>();
  const push = (source: string, eventType: string, label: string, schema: unknown) => {
    const key = `${source}/${eventType}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    events.push({
      source,
      eventType,
      label,
      fields: jsonSchemaToFields(schema as JsonSchemaObject | undefined),
    });
  };

  for (const node of graph.nodes) {
    if (node.kind !== "event") {
      continue;
    }
    const descriptor = byKey.get(`${node.source}/${node.eventType}`);
    push(node.source, node.eventType, node.label, descriptor?.payloadSchema);
  }

  if (events.length === 0) {
    for (const descriptor of descriptors) {
      push(descriptor.source, descriptor.eventType, descriptor.label, descriptor.payloadSchema);
    }
  }

  return events;
}

const EMPTY_GRAPH: WorkflowGraph = {
  version: 1,
  nodes: [],
  edges: [],
  diagnostics: [],
};

/**
 * Build the per-workflow view: the full pipeline is parsed once, then focused on
 * a single workflow. `workflowName` selects it; a name that exists as a file but
 * failed to parse stays selected and surfaces its error (rather than falling back
 * to a sibling), while a genuinely unknown/missing name falls back to the first
 * workflow. `overrides` lets callers preview unsaved edits.
 */
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
  const catalog = await loadAutomationCatalogWithSources({
    request,
    context,
    orgId,
  });
  const full = buildAutomationGraphFromCatalog(catalog, overrides);

  // Only surface workspace-layer workflows in the selector — system-layer
  // workflows are built-in platform plumbing and are hidden from the list.
  const workflowPathsByName = new Map(
    full.nodes.filter(isWorkflowNode).map((node) => [node.name, node.path]),
  );
  const parsed: WorkflowListEntry[] = listWorkflows(full).filter((workflow) => {
    const path = workflowPathsByName.get(workflow.name);
    return path !== undefined && !isSystemLayerPath(path);
  });

  // Workspace workflow files that produced no node failed to parse. List them as
  // broken so a requested-but-unparseable workflow shows its error in the viewer
  // rather than silently falling back to a sibling. Detection is path-based (a
  // file with no workflow node), so it never mistakes a parsed workflow whose
  // name differs from its filename for a broken one.
  const parsedPaths = new Set(full.nodes.filter(isWorkflowNode).map((node) => node.path));
  const broken: WorkflowListEntry[] = catalog.scripts
    .filter(
      (script) =>
        isWorkflowScriptPath(script.path) &&
        !isSystemLayerPath(script.absolutePath) &&
        !parsedPaths.has(script.absolutePath),
    )
    .map((script) => {
      const name = workflowNameFromScriptPath(script.path);
      return { name, label: name, remote: false, stepCount: 0, broken: true };
    });

  const workflows = [...parsed, ...broken].sort((a, b) => a.label.localeCompare(b.label));

  const selected =
    workflowName && workflows.some((w) => w.name === workflowName)
      ? workflowName
      : (workflows[0]?.name ?? null);

  // For a broken (no-node) selection this yields an empty graph that still
  // carries the parse error and dangling-spawn warning (see selectWorkflow).
  const graph = selected ? selectWorkflow(full, selected) : EMPTY_GRAPH;
  const source = selected ? resolveWorkflowSource(catalog, full, selected, overrides) : null;
  const events = selected ? buildRunnableEvents(graph) : [];

  return { workflows, selected, graph, source, events };
}

/**
 * Re-parse the graph for a single workflow with one file's body overridden, used
 * to live-preview unsaved edits. Returns just the focused graph + diagnostics.
 */
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
  const overrides: ScriptOverrides = new Map([[absolutePath, body]]);
  const view = await buildWorkflowGraphView({
    request,
    context,
    orgId,
    workflowName,
    overrides,
  });
  return { graph: view.graph };
}

/**
 * Manually run the selected workflow with a user-supplied trigger event.
 *
 * Codemode workflows read their input from the synthesized automation event
 * (`event.json` → `event.payload`), so a manual run is "build an event, then
 * create an instance". We invoke the registered `automation-codemode-script`
 * remote workflow directly with the selected workflow's script path — bypassing
 * the router — and return the instance id so the client can stream progress.
 */
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
