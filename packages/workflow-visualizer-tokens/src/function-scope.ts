import type { DelimiterDepth } from "./model.ts";
import type { PositionedWorkflowToken, TokenMachineContext } from "./state-machine.ts";

type BindingKind = "local" | "context-provider";

interface FunctionScopeRole {
  durableStepCallId?: string;
}

interface BlockFunctionScope extends FunctionScopeRole {
  boundary: "block";
  bodyBraces: number;
  bindings: Map<string, BindingKind>;
}

interface ExpressionFunctionScope extends FunctionScopeRole {
  boundary: "expression";
  baseDepth: DelimiterDepth;
  bindings: Map<string, BindingKind>;
}

type ActiveFunctionScope = BlockFunctionScope | ExpressionFunctionScope;

interface PendingFunctionScope extends FunctionScopeRole {
  parameterParentheses?: number;
  parametersComplete: boolean;
  bindings: Map<string, BindingKind>;
}

interface PendingArrowScope extends FunctionScopeRole {
  baseDepth: DelimiterDepth;
  bindings: Map<string, BindingKind>;
}

interface PendingMethodScope {
  parameterParentheses: number;
  parametersComplete: boolean;
}

export type ActivatedFunctionScope =
  | { boundary: "block"; durableStepCallId?: string }
  | { boundary: "expression"; baseDepth: DelimiterDepth; durableStepCallId?: string };

/** Tracks which tokens execute in the workflow callback or an explicitly durable step callback. */
export class WorkflowFunctionScopeTracker {
  readonly #activeScopes: ActiveFunctionScope[] = [];
  readonly #pendingFunctions: PendingFunctionScope[] = [];
  readonly #pendingMethods: PendingMethodScope[] = [];
  readonly #workflowBindings = new Map<string, BindingKind>();
  #pendingArrow: PendingArrowScope | undefined;

  beforeToken(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): ActivatedFunctionScope | undefined {
    this.completeConciseScopesBefore(positioned, context.depth);

    if (this.#pendingArrow) {
      const pending = this.#pendingArrow;
      this.#pendingArrow = undefined;
      const activeScope: ActiveFunctionScope =
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
            };
      this.#activeScopes.push(activeScope);
      return activeScope.boundary === "expression"
        ? {
            boundary: "expression",
            baseDepth: { ...activeScope.baseDepth },
            ...(activeScope.durableStepCallId
              ? { durableStepCallId: activeScope.durableStepCallId }
              : {}),
          }
        : {
            boundary: "block",
            ...(activeScope.durableStepCallId
              ? { durableStepCallId: activeScope.durableStepCallId }
              : {}),
          };
    }

    const pendingFunction = this.#pendingFunctions.at(-1);
    if (pendingFunction?.parametersComplete && positioned.token.value === "{") {
      this.#pendingFunctions.pop();
      this.#activeScopes.push({
        ...pendingFunction,
        boundary: "block",
        bodyBraces: context.depth.braces + 1,
      });
      return {
        boundary: "block",
        ...(pendingFunction.durableStepCallId
          ? { durableStepCallId: pendingFunction.durableStepCallId }
          : {}),
      };
    }

    while (this.#pendingMethods.at(-1)?.parametersComplete) {
      this.#pendingMethods.pop();
      if (positioned.token.value === "{") {
        this.#activeScopes.push({
          boundary: "block",
          bodyBraces: context.depth.braces + 1,
          bindings: new Map(),
        });
        return { boundary: "block" };
      }
    }

    return undefined;
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
        bindings: new Map(),
      });
      return;
    }

    this.consumePendingFunctionHeader(positioned, context.depth);
    this.consumePendingMethodHeader(positioned, context.depth);

    if (positioned.token.value === "=>") {
      this.#pendingArrow = {
        ...this.scopeRole(activeStepCallId),
        baseDepth: { ...context.depth },
        bindings: possibleArrowParameterBindings(previousTokens),
      };
      return;
    }

    if (positioned.token.value === "(" && possibleMethodParameterList(previousTokens)) {
      this.#pendingMethods.push({
        parameterParentheses: context.depth.parentheses + 1,
        parametersComplete: false,
      });
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

  directDurableStepCallId(): string | undefined {
    return this.allFunctionScopes().at(-1)?.durableStepCallId;
  }

  shadows(binding: string): boolean {
    return this.bindingKind(binding) === "local";
  }

  markContextProviderBinding(binding: string): void {
    const scopes = this.allFunctionScopes();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index];
      if (scope?.bindings.has(binding)) {
        scope.bindings.set(binding, "context-provider");
        return;
      }
    }
    if (this.#workflowBindings.has(binding)) {
      this.#workflowBindings.set(binding, "context-provider");
    }
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
      rememberPossibleBinding(pending.bindings, positioned);
    }
  }

  private consumePendingMethodHeader(
    positioned: PositionedWorkflowToken,
    depth: DelimiterDepth,
  ): void {
    const pending = this.#pendingMethods.at(-1);
    if (
      pending &&
      !pending.parametersComplete &&
      positioned.token.value === ")" &&
      depth.parentheses === pending.parameterParentheses
    ) {
      pending.parametersComplete = true;
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
    const activeScope = this.#activeScopes.at(-1);
    if (activeScope) {
      activeScope.bindings.set(positioned.token.value, "local");
    } else {
      this.#workflowBindings.set(positioned.token.value, "local");
    }
  }

  private bindingKind(binding: string): BindingKind | undefined {
    const scopes = this.allFunctionScopes();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const bindingKind = scopes[index]?.bindings.get(binding);
      if (bindingKind) {
        return bindingKind;
      }
    }
    return this.#workflowBindings.get(binding);
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

export function conciseFunctionEndsBefore(
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

function possibleArrowParameterBindings(
  previousTokens: PositionedWorkflowToken[],
): Map<string, BindingKind> {
  const previous = previousTokens.at(-1);
  if (!previous) {
    return new Map();
  }
  if (previous.token.type === "IdentifierName") {
    return new Map([[previous.token.value, "local"]]);
  }
  if (previous.token.value !== ")") {
    return new Map();
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

  const bindings = new Map<string, BindingKind>();
  for (const token of parameterTokens) {
    rememberPossibleBinding(bindings, token);
  }
  return bindings;
}

function rememberPossibleBinding(
  bindings: Map<string, BindingKind>,
  positioned: PositionedWorkflowToken,
): void {
  if (positioned.token.type === "IdentifierName") {
    bindings.set(positioned.token.value, "local");
  }
}

const NON_METHOD_PARAMETER_HEADS = new Set([
  "catch",
  "for",
  "function",
  "if",
  "switch",
  "while",
  "with",
]);

function possibleMethodParameterList(previousTokens: PositionedWorkflowToken[]): boolean {
  const methodName = previousTokens.at(-1);
  if (!methodName) {
    return false;
  }

  if (methodName.token.type === "IdentifierName") {
    if (NON_METHOD_PARAMETER_HEADS.has(methodName.token.value)) {
      return false;
    }
    const precedingValue = previousTokens.at(-2)?.token.value;
    return precedingValue !== "." && precedingValue !== "?." && precedingValue !== "function";
  }

  if (methodName.token.value !== "]") {
    return false;
  }

  let bracketDepth = 1;
  for (let index = previousTokens.length - 2; index >= 0; index -= 1) {
    const value = previousTokens[index]?.token.value;
    if (value === "]") {
      bracketDepth += 1;
    } else if (value === "[") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        const precedingValue = previousTokens[index - 1]?.token.value;
        return (
          precedingValue === undefined ||
          precedingValue === "{" ||
          precedingValue === "}" ||
          precedingValue === "," ||
          precedingValue === ";" ||
          precedingValue === "*" ||
          precedingValue === "async" ||
          precedingValue === "get" ||
          precedingValue === "set" ||
          precedingValue === "static"
        );
      }
    }
  }

  return false;
}
