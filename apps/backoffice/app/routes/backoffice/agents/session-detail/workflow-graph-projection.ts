import {
  isTriviaToken,
  tokenizeWorkflowSource,
  visualizeWorkflowSource,
  type WorkflowToken,
  type WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

export type WorkflowGraphProjection = {
  source: string;
  title: string;
  status: "constructing" | "ready";
  visualization: WorkflowVisualizationSnapshot;
};

export function projectWorkflowGraph({
  complete,
  source,
  toolCallId,
}: {
  complete: boolean;
  source: string;
  toolCallId: string;
}): WorkflowGraphProjection | null {
  if (source.trim().length === 0 || !hasDirectWorkflowCallExpression(source)) {
    return null;
  }

  const visualization = visualizeWorkflowSource(
    `session-workspace/${encodeURIComponent(toolCallId)}.js`,
    source,
    { fallbackName: "Workflow", finish: complete },
  );
  const workflows = visualization.graph.nodes.filter((node) => node.kind === "workflow");
  if (workflows.length === 0) {
    return null;
  }

  const namedWorkflow = workflows.find((workflow) => workflow.name !== "Workflow");
  const allWorkflowsComplete = workflows.every(
    (workflow) => workflow.construction.status === "complete",
  );

  return {
    source,
    title: namedWorkflow?.name ?? workflows[0]?.label ?? "Workflow",
    status: complete && allWorkflowsComplete ? "ready" : "constructing",
    visualization,
  };
}

const WORKFLOW_CALLEES = new Set(["defineWorkflow", "defineRemoteWorkflow"]);

type ClassBodyContext = "class" | "block";

function hasDirectWorkflowCallExpression(source: string): boolean {
  const tokens = [...tokenizeWorkflowSource(source)].filter((token) => !isTriviaToken(token));

  return tokens.some((token, calleeIndex) => {
    if (token.type !== "IdentifierName" || !WORKFLOW_CALLEES.has(token.value)) {
      return false;
    }

    const previousToken = tokens[calleeIndex - 1]?.value;
    if (
      previousToken === "." ||
      previousToken === "?." ||
      previousToken === "function" ||
      previousToken === "new" ||
      (previousToken === "*" && tokens[calleeIndex - 2]?.value === "function")
    ) {
      return false;
    }

    const openParenthesisIndex = workflowCallOpenParenthesisIndex(tokens, calleeIndex);
    if (openParenthesisIndex === undefined || isDirectClassMember(tokens, calleeIndex)) {
      return false;
    }

    const closeParenthesisIndex = matchingCloseParenthesisIndex(tokens, openParenthesisIndex);
    return closeParenthesisIndex === undefined || tokens[closeParenthesisIndex + 1]?.value !== "{";
  });
}

function workflowCallOpenParenthesisIndex(
  tokens: readonly WorkflowToken[],
  calleeIndex: number,
): number | undefined {
  const nextToken = tokens[calleeIndex + 1]?.value;
  if (nextToken === "(") {
    return calleeIndex + 1;
  }
  if (nextToken !== "<") {
    return undefined;
  }

  let typeArgumentDepth = 0;
  for (let index = calleeIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index]?.value ?? "";
    if (value === "<") {
      typeArgumentDepth += 1;
      continue;
    }
    if (/^>+$/u.test(value)) {
      typeArgumentDepth -= value.length;
      if (typeArgumentDepth <= 0) {
        return tokens[index + 1]?.value === "(" ? index + 1 : undefined;
      }
    }
  }

  return undefined;
}

function matchingCloseParenthesisIndex(
  tokens: readonly WorkflowToken[],
  openParenthesisIndex: number,
): number | undefined {
  let depth = 0;
  for (let index = openParenthesisIndex; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(") {
      depth += 1;
    } else if (value === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function isDirectClassMember(tokens: readonly WorkflowToken[], calleeIndex: number): boolean {
  const bodyStack: ClassBodyContext[] = [];
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let pendingClass:
    | { parenthesisDepth: number; bracketDepth: number; bodyDepth: number }
    | undefined;

  for (let index = 0; index < calleeIndex; index += 1) {
    const value = tokens[index]?.value;
    if (value === "class") {
      pendingClass = { parenthesisDepth, bracketDepth, bodyDepth: bodyStack.length };
    } else if (value === "(") {
      parenthesisDepth += 1;
    } else if (value === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    } else if (value === "[") {
      bracketDepth += 1;
    } else if (value === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (value === "{") {
      const opensClassBody =
        pendingClass?.parenthesisDepth === parenthesisDepth &&
        pendingClass.bracketDepth === bracketDepth &&
        pendingClass.bodyDepth === bodyStack.length;
      bodyStack.push(opensClassBody ? "class" : "block");
      if (opensClassBody) {
        pendingClass = undefined;
      }
    } else if (value === "}") {
      bodyStack.pop();
    }
  }

  return bodyStack.at(-1) === "class";
}
