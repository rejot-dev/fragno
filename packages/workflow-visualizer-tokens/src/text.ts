import type {
  Diagnostic,
  StepNode,
  WorkflowChildNode,
  WorkflowGraph,
  WorkflowNode,
  WorkflowVisualizationSnapshot,
} from "./model.ts";
import { isTriviaToken, tokenizeWorkflowSource } from "./tokenizer.ts";
import type { WorkflowToken } from "./tokenizer.ts";

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
      case "caught-throw":
        lines.push(
          `${prefix}${connector} ${child.order}. throw to catch${constructionSuffix(child.construction)}`,
        );
        if (child.value) {
          lines.push(`${childPrefix}value: ${singleLine(child.value)}`);
        }
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
      case "try":
        lines.push(
          `${prefix}${connector} ${child.order}. ${child.label}${constructionSuffix(child.construction)}`,
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
        if (child.value.kind === "expression") {
          lines.push(`${childPrefix}value: ${singleLine(child.value.expression)}`);
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
    ...step.analysis.returns.map((stepReturn, index): [string, string] | undefined =>
      stepReturn.value
        ? [step.analysis.returns.length === 1 ? "returns" : `return ${index + 1}`, stepReturn.value]
        : undefined,
    ),
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
  if (construction.status === "complete") {
    return "";
  }
  return ` [${construction.phase === "configured" ? "awaiting body" : construction.phase}]`;
}

function formatDepth(depth: { parentheses: number; braces: number; brackets: number }): string {
  return `(${depth.parentheses}/${depth.braces}/${depth.brackets})`;
}

function singleLine(value: string): string {
  return filterUiProperties(value).replace(/\s+/g, " ").trim();
}

function filterUiProperties(value: string): string {
  if (!value.includes("$ui")) {
    return value;
  }

  const tokens = Array.from(tokenizeWorkflowSource(value));
  const offsets: number[] = [];
  let offset = 0;

  for (const token of tokens) {
    offsets.push(offset);
    offset += token.value.length;
  }

  const replacements: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "$ui") {
      continue;
    }

    const colonIndex = nextNonTriviaTokenIndex(tokens, index + 1);
    if (colonIndex === undefined || tokens[colonIndex]?.value !== ":") {
      continue;
    }

    const valueStartIndex = nextNonTriviaTokenIndex(tokens, colonIndex + 1);
    if (valueStartIndex === undefined) {
      replacements.push({ start: offsets[index], end: value.length });
      break;
    }

    let parentheses = 0;
    let braces = 0;
    let brackets = 0;
    let end = value.length;

    for (let cursor = valueStartIndex; cursor < tokens.length; cursor += 1) {
      const tokenValue = tokens[cursor].value;
      const atPropertyBoundary = parentheses === 0 && braces === 0 && brackets === 0;
      if (atPropertyBoundary && (tokenValue === "," || tokenValue === "}")) {
        end = offsets[cursor]!;
        break;
      }

      if (tokenValue === "(") {
        parentheses += 1;
      } else if (tokenValue === ")") {
        parentheses = Math.max(0, parentheses - 1);
      } else if (tokenValue === "{") {
        braces += 1;
      } else if (tokenValue === "}") {
        braces = Math.max(0, braces - 1);
      } else if (tokenValue === "[") {
        brackets += 1;
      } else if (tokenValue === "]") {
        brackets = Math.max(0, brackets - 1);
      }
    }

    replacements.push({ start: offsets[index], end });
  }

  for (const replacement of replacements.reverse()) {
    value = `${value.slice(0, replacement.start)}$ui: …${value.slice(replacement.end)}`;
  }
  return value;
}

function nextNonTriviaTokenIndex(tokens: WorkflowToken[], start: number): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    if (!isTriviaToken(tokens[index])) {
      return index;
    }
  }
  return undefined;
}
