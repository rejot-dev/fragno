import type {
  Diagnostic,
  StepNode,
  WorkflowChildNode,
  WorkflowGraph,
  WorkflowNode,
  WorkflowVisualizationSnapshot,
} from "./model.ts";

/** Render the workflow graph without exposing tokenizer implementation details. */
export function renderWorkflowVisualizationText(snapshot: WorkflowVisualizationSnapshot): string {
  return renderWorkflowGraphText(snapshot.graph);
}

export function renderWorkflowGraphText(graph: WorkflowGraph): string {
  return renderGraphLines(graph).join("\n");
}

/** Render token counts, delimiter depth, and the active submachine hierarchy. */
export function renderWorkflowMachineDebugText(snapshot: WorkflowVisualizationSnapshot): string {
  const { state } = snapshot;
  const lines = [
    `state ${state.status} · ${state.tokenCount} tokens · ${state.sourceLength} chars · depth ${formatDepth(state.delimiterDepth)}`,
  ];
  if (state.openToken) {
    lines.push(`open ${state.openToken.type} at ${state.openToken.start}`);
  }
  if (state.activeConstructs.length > 0) {
    lines.push("active");
    for (const construct of state.activeConstructs) {
      lines.push(
        `  ${construct.kind} ${construct.id} [${construct.phase}]${construct.parentId ? ` < ${construct.parentId}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function renderGraphLines(graph: WorkflowGraph): string[] {
  const lines: string[] = [];
  const workflows = graph.nodes.filter((node): node is WorkflowNode => node.kind === "workflow");

  if (workflows.length === 0) {
    lines.push("(no workflows)");
  }

  for (const [workflowIndex, workflow] of workflows.entries()) {
    if (workflowIndex > 0) {
      lines.push("");
    }
    lines.push(
      `workflow ${workflow.name}${workflow.remote ? " (remote)" : ""}${constructionSuffix(workflow.construction)}`,
    );
    appendChildren(lines, graph, workflow.id, "");
  }

  appendDiagnostics(lines, graph.diagnostics);
  return lines;
}

function appendChildren(
  lines: string[],
  graph: WorkflowGraph,
  parentId: string,
  prefix: string,
): void {
  const children = graph.nodes
    .filter(
      (node): node is WorkflowChildNode => node.kind !== "workflow" && node.parentId === parentId,
    )
    .sort((left, right) => left.order - right.order);

  for (const [index, child] of children.entries()) {
    const last = index === children.length - 1;
    const connector = last ? "└─" : "├─";
    const childPrefix = `${prefix}${last ? "   " : "│  "}`;

    switch (child.kind) {
      case "branch":
        lines.push(`${prefix}${connector} ${child.label}${constructionSuffix(child.construction)}`);
        break;
      case "condition":
        lines.push(
          `${prefix}${connector} ${child.order}. ${child.label}${constructionSuffix(child.construction)}`,
        );
        break;
      case "loop":
        lines.push(
          `${prefix}${connector} ${child.order}. ${child.label}${constructionSuffix(child.construction)}`,
        );
        break;
      case "parallel":
        lines.push(
          `${prefix}${connector} ${child.order}. parallel ${child.label}${constructionSuffix(child.construction)}`,
        );
        break;
      case "terminal": {
        const terminalLabel =
          child.terminalType === "early-return"
            ? "early return"
            : child.terminalType === "final-return"
              ? "final return"
              : "error";
        const label =
          child.label === terminalLabel || child.label === "return" ? "" : ` ${child.label}`;
        lines.push(
          `${prefix}${connector} ${child.order}. terminal ${terminalLabel}${label}${constructionSuffix(child.construction)}`,
        );
        if (child.value) {
          lines.push(`${childPrefix}value: ${singleLine(child.value)}`);
        }
        break;
      }
      case "step": {
        const label =
          child.label === child.stepType || child.label === `${child.stepType} step`
            ? ""
            : ` ${child.label}`;
        lines.push(
          `${prefix}${connector} ${child.order}. ${child.stepType}${label}${constructionSuffix(child.construction)}`,
        );
        appendStepDetails(lines, childPrefix, child);
        break;
      }
    }

    appendChildren(lines, graph, child.id, childPrefix);
  }
}

function appendStepDetails(lines: string[], indent: string, step: StepNode): void {
  const details = [
    step.meta.duration ? ["duration", step.meta.duration] : undefined,
    step.meta.until ? ["until", step.meta.until] : undefined,
    step.meta.eventType ? ["event", step.meta.eventType] : undefined,
    step.meta.timeout ? ["timeout", step.meta.timeout] : undefined,
  ].filter((detail): detail is [string, string] => detail !== undefined);

  for (const [name, value] of details) {
    lines.push(`${indent}${name}: ${singleLine(value)}`);
  }
}

function appendDiagnostics(lines: string[], diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) {
    return;
  }
  lines.push("diagnostics");
  for (const diagnostic of diagnostics) {
    lines.push(
      `  ${diagnostic.severity} ${diagnostic.code} at ${diagnostic.source.start.line}:${diagnostic.source.start.column} — ${diagnostic.message}`,
    );
  }
}

function constructionSuffix(construction: {
  status: "partial" | "complete";
  phase: string;
}): string {
  return construction.status === "partial" ? ` [${construction.phase}]` : "";
}

function formatDepth(depth: { parentheses: number; braces: number; brackets: number }): string {
  return `(${depth.parentheses}/${depth.braces}/${depth.brackets})`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
