import {
  type Diagnostic,
  type EventDescriptor,
  type EventNode,
  type GraphEdge,
  type GraphNode,
  type RouterNode,
  type ScriptNode,
  type StepNode,
  type WorkflowGraph,
  type WorkflowNode,
  eventNodeId,
  scriptNodeId,
  workflowNodeId,
} from "./model.ts";
import { parseRouterFile } from "./parse/router.ts";
import { parseWorkflowFile } from "./parse/workflow.ts";

export type FileKind = "router" | "workflow" | "script";

export interface FileEntry {
  kind: FileKind;
  source: string;
  engine: "bash" | "codemode";
  enabled: boolean;
}

export interface BuildInput {
  catalog: EventDescriptor[];
  files: Map<string, FileEntry>;
}

/** Pure function: source state in, full graph out. The interpreter diffs successive builds. */
export function build({ catalog, files }: BuildInput): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  // 1. Event nodes from the structured catalog.
  for (const descriptor of catalog) {
    const node: EventNode = {
      id: eventNodeId(descriptor.source, descriptor.eventType),
      kind: "event",
      label: descriptor.label ?? `${descriptor.source}/${descriptor.eventType}`,
      source: descriptor.source,
      eventType: descriptor.eventType,
      scope: descriptor.scope,
      description: descriptor.description,
    };
    nodes.push(node);
  }

  // 2. Per-file contributions.
  const workflowDefiners = new Map<string, string>(); // workflow name -> path
  for (const [path, entry] of files) {
    if (entry.kind === "workflow") {
      const contribution = parseWorkflowFile(path, entry.source);
      nodes.push(...contribution.nodes);
      edges.push(...contribution.edges);
      diagnostics.push(...contribution.diagnostics);
      for (const name of contribution.workflowNames) {
        const existing = workflowDefiners.get(name);
        if (existing && existing !== path) {
          diagnostics.push({
            severity: "error",
            code: "duplicate-workflow",
            message: `Workflow "${name}" is defined in both ${existing} and ${path}.`,
            ref: { path },
          });
        } else {
          workflowDefiners.set(name, path);
        }
      }
    } else if (entry.kind === "router") {
      const contribution = parseRouterFile(path, entry.source);
      nodes.push(...contribution.nodes);
      edges.push(...contribution.edges);
      diagnostics.push(...contribution.diagnostics);
    } else {
      const node: ScriptNode = {
        id: scriptNodeId(path),
        kind: "script",
        label: path,
        engine: entry.engine,
        path,
        enabled: entry.enabled,
      };
      nodes.push(node);
    }
  }

  // 3. Cross-link router rules to events and workflows.
  resolveRouterEdges(nodes, edges, diagnostics);

  return { version: 1, nodes, edges, diagnostics };
}

function resolveRouterEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  diagnostics: Diagnostic[],
): void {
  const eventIds = new Set(
    nodes.filter((n): n is EventNode => n.kind === "event").map((n) => n.id),
  );
  const workflowsByName = new Map(
    nodes.filter((n): n is WorkflowNode => n.kind === "workflow").map((n) => [n.name, n]),
  );
  // event types each workflow waits for, so we can wire `sendEvent` to the right workflow.
  const workflowsByWaitType = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    if (node.kind !== "step") {
      continue;
    }
    const step = node as StepNode;
    if (step.stepType !== "waitForEvent" || !step.meta.eventType) {
      continue;
    }
    const workflow = workflowsByName.get(step.workflowName);
    if (!workflow) {
      continue;
    }
    const list = workflowsByWaitType.get(step.meta.eventType) ?? [];
    list.push(workflow);
    workflowsByWaitType.set(step.meta.eventType, list);
  }

  for (const node of nodes) {
    if (node.kind !== "router") {
      continue;
    }
    const router = node as RouterNode;

    if (router.action === "spawn") {
      // event -> router (when the rule matched a known catalog event)
      if (router.match.source && router.match.eventType) {
        const evId = eventNodeId(router.match.source, router.match.eventType);
        if (eventIds.has(evId)) {
          edges.push({
            id: `matches:${evId}->${router.id}`,
            from: evId,
            to: router.id,
            type: "matches",
          });
        } else {
          diagnostics.push({
            severity: "info",
            code: "unknown-event",
            message: `Router matches ${router.match.source}/${router.match.eventType}, which is not in the event catalog.`,
            ref: router.ref,
          });
        }
      }
      // router -> workflow
      if (router.targetWorkflowName) {
        const workflow = workflowsByName.get(router.targetWorkflowName);
        if (workflow) {
          edges.push({
            id: `spawns:${router.id}->${workflow.id}`,
            from: router.id,
            to: workflow.id,
            type: "spawns",
          });
        } else {
          diagnostics.push({
            severity: "warning",
            code: "unknown-workflow",
            message: `Router spawns workflow "${router.targetWorkflowName}", which has no definition.`,
            ref: router.ref,
          });
        }
      }
    } else if (router.action === "sendEvent" && router.eventType) {
      // router (sendEvent) -> every workflow that waits for that event type
      const waiters = workflowsByWaitType.get(router.eventType) ?? [];
      for (const workflow of waiters) {
        edges.push({
          id: `sends:${router.id}->${workflow.id}`,
          from: router.id,
          to: workflow.id,
          type: "sends",
          label: router.eventType,
        });
      }
      if (waiters.length === 0) {
        // Wire the matched event back as the trigger when present.
        if (router.match.source && router.match.eventType) {
          const evId = eventNodeId(router.match.source, router.match.eventType);
          if (eventIds.has(evId)) {
            edges.push({
              id: `matches:${evId}->${router.id}`,
              from: evId,
              to: router.id,
              type: "matches",
            });
          }
        }
      }
    }
  }
}

export function workflowExists(graph: WorkflowGraph, name: string): boolean {
  return graph.nodes.some((n) => n.id === workflowNodeId(name));
}

/**
 * Build a graph for a single piece of codemode workflow source — the raw `code`
 * `execCodeMode` runs. Wraps it as one codemode workflow file and runs the normal
 * build, so a bare `async (event, step) => {…}`, a `defineWorkflow(...)` call, or a
 * `{ run }` object all resolve to the same workflow + step graph the viewer renders.
 * `name` labels the workflow (and seeds the derived name for anonymous functions).
 */
export function buildCodemodeWorkflowGraph(
  code: string,
  options?: { name?: string },
): WorkflowGraph {
  const name = options?.name ?? "codemode";
  const files = new Map<string, FileEntry>([
    [name, { kind: "workflow", source: code, engine: "codemode", enabled: true }],
  ]);
  return build({ catalog: [], files });
}
