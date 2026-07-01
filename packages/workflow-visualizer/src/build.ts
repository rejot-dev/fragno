import {
  type Diagnostic,
  type EventDescriptor,
  type EventNode,
  type GraphEdge,
  type GraphNode,
  type ScriptNode,
  type WorkflowGraph,
  eventNodeId,
  scriptNodeId,
  workflowNodeId,
} from "./model.ts";
import { parseWorkflowFile } from "./parse/workflow.ts";

export type FileKind = "workflow" | "script";

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

  return { version: 1, nodes, edges, diagnostics };
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
