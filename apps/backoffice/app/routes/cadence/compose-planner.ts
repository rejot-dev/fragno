/*
 * The compose planner — turns a plain-language prompt into a `ComposeResult`
 * (the typed output stream the prompt renders). This is the single seam an LLM
 * later replaces: callers depend only on `planCompose(prompt) => ComposeResult`,
 * so swapping the deterministic heuristics below for a model call touches nothing
 * else.
 *
 * Today it is deterministic and self-contained: it parses the prompt into
 * ordered steps, then emits a representative stream — a narrative summary, a plan
 * table, a step-breakdown chart, and a drafted workflow graph. Every block is
 * derived from the prompt (no fabricated metrics), and the result is validated
 * against `composeResultSchema` so the shape is guaranteed for the client.
 */

import {
  composeResultSchema,
  type ChartBlock,
  type ComposeBlock,
  type ComposeResult,
  type TableBlock,
  type TextBlock,
  type WorkflowBlock,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
} from "@/components/cadence/prompt/output/output-model";

const NODE_GAP_X = 280;
const NODE_Y = 120;

type ParsedStep = {
  kind: WorkflowNodeKind;
  label: string;
  description?: string;
};

/** Split a prompt into ordered clauses on commas and sequencing words. */
function splitClauses(prompt: string): string[] {
  return prompt
    .split(/,|\band then\b|\bthen\b|\band\b|;/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** Trim a leading connector ("when", "if", "after") and capitalize. */
function cleanClause(clause: string): string {
  const stripped = clause.replace(/^(when|if|after|once|whenever)\s+/i, "").trim();
  const text = stripped || clause;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Short label for a node (first few words), keeping the full text as detail. */
function toLabel(text: string): string {
  const words = text.split(/\s+/);
  return words.length <= 5 ? text : `${words.slice(0, 5).join(" ")}…`;
}

/** Classify a clause into a node kind from its leading verb / keywords. */
function classifyClause(clause: string, index: number): WorkflowNodeKind {
  const lower = clause.toLowerCase();
  if (index === 0 && /^(when|if|after|once|whenever|on )/.test(lower)) {
    return "trigger";
  }
  if (/\bif\b|\bwhen\b|\bunless\b|\bonly if\b/.test(lower)) {
    return "condition";
  }
  if (/\bwait\b|\bdelay\b|\bafter\b|\bat period end\b|\bin \d/.test(lower)) {
    return "delay";
  }
  if (/\bnotify\b|\bemail\b|\bsend\b|\bflag\b|\balert\b|\breport\b/.test(lower)) {
    return "output";
  }
  return "action";
}

export function parseSteps(prompt: string): ParsedStep[] {
  const clauses = splitClauses(prompt);

  if (clauses.length === 0) {
    return [{ kind: "trigger", label: "Manual trigger" }];
  }

  const steps: ParsedStep[] = clauses.map((clause, index) => {
    const detail = cleanClause(clause);
    return {
      kind: classifyClause(clause, index),
      label: toLabel(detail),
      description: detail,
    };
  });

  // Always start with a trigger and end with an output, so the graph is a
  // complete, runnable-looking shape.
  if (steps[0].kind !== "trigger") {
    steps.unshift({ kind: "trigger", label: "Manual trigger" });
  }
  if (steps[steps.length - 1].kind !== "output") {
    steps.push({ kind: "output", label: "Complete", description: "Mark the automation done" });
  }

  return steps;
}

function buildGraph(steps: ParsedStep[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = steps.map((step, index) => ({
    id: `node-${index}`,
    kind: step.kind,
    label: step.label,
    ...(step.description ? { description: step.description } : {}),
    position: { x: 80 + index * NODE_GAP_X, y: NODE_Y },
  }));

  const edges: WorkflowEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({
      id: `edge-${index}`,
      source: nodes[index].id,
      target: nodes[index + 1].id,
    });
  }

  return { nodes, edges };
}

function buildTextBlock(prompt: string, steps: ParsedStep[]): TextBlock {
  const actionCount = steps.filter((step) => step.kind === "action").length;
  return {
    id: "block-summary",
    type: "text",
    markdown: [
      `Here's how I'd automate that. I read your request as **${steps.length} steps**` +
        `${actionCount > 0 ? ` (${actionCount} action${actionCount === 1 ? "" : "s"})` : ""}.`,
      "",
      "Review the plan and the drafted workflow below — open it in **build** to refine the graph.",
    ].join("\n"),
  };
}

function buildPlanTable(steps: ParsedStep[]): TableBlock {
  return {
    id: "block-plan",
    type: "table",
    title: "Plan",
    columns: ["#", "Type", "Step"],
    rows: steps.map((step, index) => [index + 1, step.kind, step.description ?? step.label]),
  };
}

function buildBreakdownChart(steps: ParsedStep[]): ChartBlock {
  const kinds: WorkflowNodeKind[] = ["trigger", "action", "condition", "delay", "output"];
  const present = kinds.filter((kind) => steps.some((step) => step.kind === kind));
  return {
    id: "block-breakdown",
    type: "chart",
    title: "Step breakdown",
    variant: "bar",
    categories: present,
    series: [
      {
        name: "Steps",
        values: present.map((kind) => steps.filter((step) => step.kind === kind).length),
      },
    ],
  };
}

function buildWorkflowBlock(prompt: string, steps: ParsedStep[]): WorkflowBlock {
  return {
    id: "block-workflow",
    type: "workflow",
    title: "Drafted workflow",
    summary: `${steps.length} steps, wired in sequence.`,
    graph: buildGraph(steps),
  };
}

/**
 * The seam. Replace the body with an LLM call that returns the same
 * `ComposeResult` shape; everything downstream is unchanged.
 */
export function planCompose(prompt: string): ComposeResult {
  const trimmed = prompt.trim();
  const steps = parseSteps(trimmed);

  const blocks: ComposeBlock[] = [
    buildTextBlock(trimmed, steps),
    buildPlanTable(steps),
    buildBreakdownChart(steps),
    buildWorkflowBlock(trimmed, steps),
  ];

  // Validate at the seam so callers (and a future LLM implementation) can't
  // produce a shape the client doesn't understand.
  return composeResultSchema.parse({ prompt: trimmed, blocks });
}
