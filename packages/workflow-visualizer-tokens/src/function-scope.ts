import type { DelimiterDepth } from "./model.ts";
import type { PositionedWorkflowToken, TokenMachineContext } from "./state-machine.ts";

interface FunctionScopeRole {
  durableStepCallId?: string;
}

interface BlockFunctionScope extends FunctionScopeRole {
  boundary: "block";
  bodyBraces: number;
  shadowedBindings: Set<string>;
}

interface ExpressionFunctionScope extends FunctionScopeRole {
  boundary: "expression";
  baseDepth: DelimiterDepth;
  shadowedBindings: Set<string>;
}

type ActiveFunctionScope = BlockFunctionScope | ExpressionFunctionScope;

interface PendingFunctionScope extends FunctionScopeRole {
  parameterParentheses?: number;
  parametersComplete: boolean;
  shadowedBindings: Set<string>;
}

interface PendingArrowScope extends FunctionScopeRole {
  baseDepth: DelimiterDepth;
  shadowedBindings: Set<string>;
}

/** Tracks which tokens execute in the workflow callback or an explicitly durable step callback. */
export class WorkflowFunctionScopeTracker {
  readonly #activeScopes: ActiveFunctionScope[] = [];
  readonly #pendingFunctions: PendingFunctionScope[] = [];
  #pendingArrow: PendingArrowScope | undefined;

  beforeToken(positioned: PositionedWorkflowToken, context: TokenMachineContext): void {
    this.completeConciseScopesBefore(positioned, context.depth);

    if (this.#pendingArrow) {
      const pending = this.#pendingArrow;
      this.#pendingArrow = undefined;
      this.#activeScopes.push(
        positioned.token.value === "{"
          ? {
              ...pending,
              boundary: "block",
              bodyBraces: context.depth.braces + 1,
            }
          : {
              ...pending,
              boundary: "expression",
              baseDepth: { ...pending.baseDepth },
            },
      );
    }

    const pendingFunction = this.#pendingFunctions.at(-1);
    if (pendingFunction?.parametersComplete && positioned.token.value === "{") {
      this.#pendingFunctions.pop();
      this.#activeScopes.push({
        ...pendingFunction,
        boundary: "block",
        bodyBraces: context.depth.braces + 1,
      });
    }
  }

  afterToken({
    positioned,
    context,
    previousTokens,
    activeStepCallId,
  }: {
    positioned: PositionedWorkflowToken;
    context: TokenMachineContext;
    previousTokens: PositionedWorkflowToken[];
    activeStepCallId?: string;
  }): void {
    this.completeBlockScopeAfter(positioned, context.depth);

    if (positioned.token.value === "function") {
      this.#pendingFunctions.push({
        ...this.scopeRole(activeStepCallId),
        parametersComplete: false,
        shadowedBindings: new Set(),
      });
      return;
    }

    this.consumePendingFunctionHeader(positioned, context.depth);

    if (positioned.token.value === "=>") {
      this.#pendingArrow = {
        ...this.scopeRole(activeStepCallId),
        baseDepth: { ...context.depth },
        shadowedBindings: possibleArrowParameterBindings(previousTokens),
      };
      return;
    }

    this.rememberLocalBinding(positioned, previousTokens.at(-1));
  }

  isNestedFunction(): boolean {
    return (
      this.#activeScopes.length > 0 ||
      this.#pendingFunctions.length > 0 ||
      this.#pendingArrow !== undefined
    );
  }

  allowsWorkflowConstructDiscovery(): boolean {
    return this.allFunctionScopes().every((scope) => scope.durableStepCallId !== undefined);
  }

  shadows(binding: string): boolean {
    return this.allFunctionScopes().some((scope) => scope.shadowedBindings.has(binding));
  }

  private completeConciseScopesBefore(
    positioned: PositionedWorkflowToken,
    depth: DelimiterDepth,
  ): void {
    while (true) {
      const scope = this.#activeScopes.at(-1);
      if (
        scope?.boundary !== "expression" ||
        !conciseFunctionEndsBefore(positioned.token.value, depth, scope.baseDepth)
      ) {
        return;
      }
      this.#activeScopes.pop();
    }
  }

  private completeBlockScopeAfter(
    positioned: PositionedWorkflowToken,
    depth: DelimiterDepth,
  ): void {
    const scope = this.#activeScopes.at(-1);
    if (
      scope?.boundary === "block" &&
      positioned.token.value === "}" &&
      depth.braces === scope.bodyBraces
    ) {
      this.#activeScopes.pop();
    }
  }

  private consumePendingFunctionHeader(
    positioned: PositionedWorkflowToken,
    depth: DelimiterDepth,
  ): void {
    const pending = this.#pendingFunctions.at(-1);
    if (!pending || pending.parametersComplete) {
      return;
    }

    if (pending.parameterParentheses === undefined) {
      if (positioned.token.value === "(") {
        pending.parameterParentheses = depth.parentheses + 1;
      }
      return;
    }

    if (positioned.token.value === ")" && depth.parentheses === pending.parameterParentheses) {
      pending.parametersComplete = true;
      return;
    }

    if (depth.parentheses >= pending.parameterParentheses) {
      rememberPossibleBinding(pending.shadowedBindings, positioned);
    }
  }

  private rememberLocalBinding(
    positioned: PositionedWorkflowToken,
    previous: PositionedWorkflowToken | undefined,
  ): void {
    if (
      positioned.token.type !== "IdentifierName" ||
      (previous?.token.value !== "const" &&
        previous?.token.value !== "let" &&
        previous?.token.value !== "var")
    ) {
      return;
    }
    this.#activeScopes.at(-1)?.shadowedBindings.add(positioned.token.value);
  }

  private scopeRole(activeStepCallId: string | undefined): FunctionScopeRole {
    // The direct callback of each durable step may itself declare nested durable steps.
    // Deeper callbacks (for example `.map()`) return to ordinary JavaScript function semantics.
    if (!activeStepCallId || this.claimedDurableStepCallIds().has(activeStepCallId)) {
      return {};
    }
    return { durableStepCallId: activeStepCallId };
  }

  private claimedDurableStepCallIds(): Set<string> {
    return new Set(
      this.allFunctionScopes().flatMap((scope) =>
        scope.durableStepCallId ? [scope.durableStepCallId] : [],
      ),
    );
  }

  private allFunctionScopes(): Array<
    ActiveFunctionScope | PendingFunctionScope | PendingArrowScope
  > {
    return [
      ...this.#activeScopes,
      ...this.#pendingFunctions,
      ...(this.#pendingArrow ? [this.#pendingArrow] : []),
    ];
  }
}

function conciseFunctionEndsBefore(
  tokenValue: string,
  depth: DelimiterDepth,
  baseDepth: DelimiterDepth,
): boolean {
  if (tokenValue === ";" || tokenValue === ",") {
    return sameDepth(depth, baseDepth);
  }
  if (tokenValue === ")") {
    return (
      depth.parentheses === baseDepth.parentheses &&
      depth.braces === baseDepth.braces &&
      depth.brackets === baseDepth.brackets
    );
  }
  if (tokenValue === "]") {
    return (
      depth.brackets === baseDepth.brackets &&
      depth.parentheses <= baseDepth.parentheses &&
      depth.braces === baseDepth.braces
    );
  }
  if (tokenValue === "}") {
    return (
      depth.braces === baseDepth.braces &&
      depth.parentheses <= baseDepth.parentheses &&
      depth.brackets <= baseDepth.brackets
    );
  }
  return false;
}

function sameDepth(left: DelimiterDepth, right: DelimiterDepth): boolean {
  return (
    left.parentheses === right.parentheses &&
    left.braces === right.braces &&
    left.brackets === right.brackets
  );
}

function possibleArrowParameterBindings(previousTokens: PositionedWorkflowToken[]): Set<string> {
  const previous = previousTokens.at(-1);
  if (!previous) {
    return new Set();
  }
  if (previous.token.type === "IdentifierName") {
    return new Set([previous.token.value]);
  }
  if (previous.token.value !== ")") {
    return new Set();
  }

  let parentheses = 1;
  const parameterTokens: PositionedWorkflowToken[] = [];
  for (let index = previousTokens.length - 2; index >= 0; index -= 1) {
    const token = previousTokens[index];
    if (!token) {
      continue;
    }
    if (token.token.value === ")") {
      parentheses += 1;
    } else if (token.token.value === "(") {
      parentheses -= 1;
      if (parentheses === 0) {
        break;
      }
    }
    if (parentheses > 0) {
      parameterTokens.push(token);
    }
  }

  const bindings = new Set<string>();
  for (const token of parameterTokens) {
    rememberPossibleBinding(bindings, token);
  }
  return bindings;
}

function rememberPossibleBinding(bindings: Set<string>, positioned: PositionedWorkflowToken): void {
  if (positioned.token.type === "IdentifierName") {
    bindings.add(positioned.token.value);
  }
}
