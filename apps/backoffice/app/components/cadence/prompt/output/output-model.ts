/*
 * The compose output model — the contract between the server (which produces a
 * compose result) and the client (which renders it). It is deliberately
 * UI-framework-free so both the route action and the React renderers can import
 * it.
 *
 * The shape mirrors the two output capabilities the prompt supports:
 *
 *   1. A single, heterogeneous *stream* of blocks (`ComposeBlock`). Each block
 *      is a discriminated union member with its own payload; the renderer
 *      registry (`./blocks/registry`) maps each `type` to a component, so adding
 *      a new kind of output is "add a schema member + a renderer" and nothing
 *      else changes.
 *
 *   2. A *build* surface — a node graph (`WorkflowGraph`) that the build-mode
 *      playground edits. A `workflow` block in the stream carries a graph and
 *      can be opened into the playground; the playground can also start blank.
 *
 * Everything is zod-validated so a planner (and, later, an LLM) producing this
 * server-side is parsed at the boundary, and the client can trust the shapes.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Workflow graph — the artifact the build-mode playground constructs.        */
/* -------------------------------------------------------------------------- */

/**
 * The role a node plays in a workflow. Kept intentionally small and obvious;
 * each kind gets its own visual treatment in the playground. This is a *design*
 * model — it is not (yet) compiled to a real `@fragno-dev/workflows` definition.
 */
export const WORKFLOW_NODE_KINDS = ["trigger", "action", "condition", "delay", "output"] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const workflowNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(WORKFLOW_NODE_KINDS),
  label: z.string(),
  description: z.string().optional(),
  /** Canvas position. The planner lays nodes out; the user can drag them after. */
  position: z.object({ x: z.number(), y: z.number() }),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** Optional label, e.g. the branch a `condition` node takes ("yes" / "no"). */
  label: z.string().optional(),
});
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

/* -------------------------------------------------------------------------- */
/*  Stream blocks — the heterogeneous output stream.                           */
/* -------------------------------------------------------------------------- */

const blockBase = { id: z.string() };

/** Prose / markdown — the default narrative output of a compose run. */
export const textBlockSchema = z.object({
  ...blockBase,
  type: z.literal("text"),
  markdown: z.string(),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

/** Tabular structured data. Cells are primitives so the result is serializable. */
export const tableBlockSchema = z.object({
  ...blockBase,
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});
export type TableBlock = z.infer<typeof tableBlockSchema>;

/** A simple categorical chart. Each series' `values` align to `categories`. */
export const chartBlockSchema = z.object({
  ...blockBase,
  type: z.literal("chart"),
  title: z.string().optional(),
  variant: z.enum(["line", "bar"]),
  categories: z.array(z.string()),
  series: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.number()),
    }),
  ),
});
export type ChartBlock = z.infer<typeof chartBlockSchema>;

/**
 * A compact preview of a drafted workflow. It carries the full graph so the
 * card can summarize it and the user can open it into the build playground.
 */
export const workflowBlockSchema = z.object({
  ...blockBase,
  type: z.literal("workflow"),
  title: z.string(),
  summary: z.string().optional(),
  graph: workflowGraphSchema,
});
export type WorkflowBlock = z.infer<typeof workflowBlockSchema>;

export const composeBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  workflowBlockSchema,
]);
export type ComposeBlock = z.infer<typeof composeBlockSchema>;
export type ComposeBlockType = ComposeBlock["type"];

/* -------------------------------------------------------------------------- */
/*  Compose result — what the server returns for one conducted prompt.         */
/* -------------------------------------------------------------------------- */

export const composeResultSchema = z.object({
  /** Echo of the prompt that produced this result, for display. */
  prompt: z.string(),
  /** The ordered output stream. */
  blocks: z.array(composeBlockSchema),
});
export type ComposeResult = z.infer<typeof composeResultSchema>;

/** Convenience: pull the first workflow block out of a result, if any. */
export function firstWorkflowBlock(blocks: readonly ComposeBlock[]): WorkflowBlock | undefined {
  return blocks.find((block): block is WorkflowBlock => block.type === "workflow");
}

/** An empty graph, for starting the build playground from scratch. */
export const EMPTY_WORKFLOW_GRAPH: WorkflowGraph = { nodes: [], edges: [] };
