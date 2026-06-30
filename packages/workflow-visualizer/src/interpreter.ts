import { type BuildInput, type FileEntry, type FileKind, build } from "./build.ts";
import { type EventDescriptor, type GraphPatch, type WorkflowGraph } from "./model.ts";

export interface UpdateFileOptions {
  /** Override the inferred file role. */
  kind?: FileKind;
  /** Script engine; inferred from the extension when omitted. */
  engine?: "bash" | "codemode";
  /** Whether the script is enabled (workflows default to false, scripts to true). */
  enabled?: boolean;
}

export interface Interpreter {
  /** Set the declared automation events (capability descriptors). */
  setEventCatalog(catalog: EventDescriptor[]): void;
  /** Add or replace a source file and re-derive the graph. */
  updateFile(path: string, source: string, options?: UpdateFileOptions): void;
  /** Remove a source file and re-derive the graph. */
  removeFile(path: string): void;
  /** The current materialized graph (for late joiners / initial load). */
  snapshot(): WorkflowGraph;
  /**
   * Subscribe to graph patches. The subscriber immediately receives a `reset`
   * patch carrying the current snapshot, then deltas as files change.
   * Returns an unsubscribe function.
   */
  onPatch(listener: (patch: GraphPatch) => void): () => void;
}

const EMPTY_GRAPH: WorkflowGraph = { version: 1, nodes: [], edges: [], diagnostics: [] };

export function createInterpreter(): Interpreter {
  let catalog: EventDescriptor[] = [];
  const files = new Map<string, FileEntry>();
  let current: WorkflowGraph = EMPTY_GRAPH;
  const listeners = new Set<(patch: GraphPatch) => void>();

  function rebuild(): void {
    const input: BuildInput = { catalog, files };
    const next = build(input);
    const patches = diffGraph(current, next);
    current = next;
    if (patches.length === 0) {
      return;
    }
    for (const patch of patches) {
      for (const listener of listeners) {
        listener(patch);
      }
    }
  }

  return {
    setEventCatalog(next) {
      catalog = next;
      rebuild();
    },
    updateFile(path, source, options) {
      files.set(path, {
        kind: options?.kind ?? inferKind(path),
        source,
        engine: options?.engine ?? inferEngine(path),
        enabled: options?.enabled ?? !path.endsWith(".workflow.js"),
      });
      rebuild();
    },
    removeFile(path) {
      if (files.delete(path)) {
        rebuild();
      }
    },
    snapshot() {
      return current;
    },
    onPatch(listener) {
      listeners.add(listener);
      listener({ type: "reset", graph: current });
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function inferKind(path: string): FileKind {
  const base = path.split("/").pop() ?? path;
  if (base === "router.cm.js" || base === "router.js" || base.startsWith("router.")) {
    return "router";
  }
  if (path.endsWith(".workflow.js")) {
    return "workflow";
  }
  return "script";
}

function inferEngine(path: string): "bash" | "codemode" {
  return path.endsWith(".cm.js") || path.endsWith(".js") ? "codemode" : "bash";
}

/** Structural diff of two graphs into the minimal patch set, identity by node/edge id. */
export function diffGraph(prev: WorkflowGraph, next: WorkflowGraph): GraphPatch[] {
  const patches: GraphPatch[] = [];

  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  for (const [id, node] of nextNodes) {
    const before = prevNodes.get(id);
    if (!before || !shallowJsonEqual(before, node)) {
      patches.push({ type: "node.upsert", node });
    }
  }
  for (const id of prevNodes.keys()) {
    if (!nextNodes.has(id)) {
      patches.push({ type: "node.remove", id });
    }
  }

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e]));
  for (const [id, edge] of nextEdges) {
    const before = prevEdges.get(id);
    if (!before || !shallowJsonEqual(before, edge)) {
      patches.push({ type: "edge.upsert", edge });
    }
  }
  for (const id of prevEdges.keys()) {
    if (!nextEdges.has(id)) {
      patches.push({ type: "edge.remove", id });
    }
  }

  if (!shallowJsonEqual(prev.diagnostics, next.diagnostics)) {
    patches.push({ type: "diagnostics.set", diagnostics: next.diagnostics });
  }

  return patches;
}

function shallowJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
