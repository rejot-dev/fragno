import type { DelimiterDepth } from "./model.ts";
import type { PositionedWorkflowToken, TokenMachineContext } from "./state-machine.ts";

type Binding =
  | { kind: "local" }
  | { kind: "context-provider" }
  | { kind: "helper"; helperId: string };

/**
 * What a function's body means to the workflow. Only `ordinary` functions are opaque: the others
 * run as workflow code, so durable constructs inside them are part of the workflow graph.
 */
export type FunctionScopeRole =
  | { kind: "ordinary" }
  /** The direct callback of a durable step. */
  | { kind: "durable-step"; stepCallId: string }
  /** The callback of `Promise.all(items.map(callback))`, which runs once per item. */
  | { kind: "fan-out" }
  /** A named function in workflow code, expanded wherever the workflow calls it. */
  | { kind: "helper"; helperId: string };

interface BlockFunctionScope {
  boundary: "block";
  role: FunctionScopeRole;
  bodyBraces: number;
  bindings: Map<string, Binding>;
}

interface ExpressionFunctionScope {
  boundary: "expression";
  role: FunctionScopeRole;
  baseDepth: DelimiterDepth;
  bindings: Map<string, Binding>;
}

type ActiveFunctionScope = BlockFunctionScope | ExpressionFunctionScope;

interface PendingFunctionScope {
  role: FunctionScopeRole;
  parameterParentheses?: number;
  parametersComplete: boolean;
  bindings: Map<string, Binding>;
}

interface PendingArrowScope {
  role: FunctionScopeRole;
  baseDepth: DelimiterDepth;
  bindings: Map<string, Binding>;
}

interface PendingMethodScope {
  parameterParentheses: number;
  parametersComplete: boolean;
}

export type ActivatedFunctionScope =
  | { boundary: "block"; role: FunctionScopeRole; bodyBraces: number }
  | { boundary: "expression"; role: FunctionScopeRole; baseDepth: DelimiterDepth };

/** Tracks which tokens execute in the workflow callback or an explicitly durable step callback. */
export class WorkflowFunctionScopeTracker {
  readonly #activeScopes: ActiveFunctionScope[] = [];
  readonly #pendingFunctions: PendingFunctionScope[] = [];
  readonly #pendingMethods: PendingMethodScope[] = [];
  readonly #workflowBindings = new Map<string, Binding>();
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
      return activatedScope(activeScope);
    }

    const pendingFunction = this.#pendingFunctions.at(-1);
    if (pendingFunction?.parametersComplete && positioned.token.value === "{") {
      this.#pendingFunctions.pop();
      const activeScope: BlockFunctionScope = {
        role: pendingFunction.role,
        bindings: pendingFunction.bindings,
        boundary: "block",
        bodyBraces: context.depth.braces + 1,
      };
      this.#activeScopes.push(activeScope);
      return activatedScope(activeScope);
    }

    while (this.#pendingMethods.at(-1)?.parametersComplete) {
      this.#pendingMethods.pop();
      if (positioned.token.value === "{") {
        const activeScope: BlockFunctionScope = {
          boundary: "block",
          role: { kind: "ordinary" },
          bodyBraces: context.depth.braces + 1,
          bindings: new Map(),
        };
        this.#activeScopes.push(activeScope);
        return activatedScope(activeScope);
      }
    }

    return undefined;
  }

  afterToken({
    positioned,
    context,
    previousTokens,
    activeStepCallId,
    fanOutCallback,
  }: {
    positioned: PositionedWorkflowToken;
    context: TokenMachineContext;
    previousTokens: PositionedWorkflowToken[];
    activeStepCallId: string | undefined;
    /** Whether a function starting at this token is the callback of a durable fan-out. */
    fanOutCallback: boolean;
  }): void {
    this.completeBlockScopeAfter(positioned, context.depth);

    if (positioned.token.value === "function") {
      this.#pendingFunctions.push({
        role: this.scopeRole(activeStepCallId, fanOutCallback),
        parametersComplete: false,
        bindings: new Map(),
      });
      return;
    }

    this.consumePendingFunctionHeader(positioned, context.depth);
    this.consumePendingMethodHeader(positioned, context.depth);

    if (positioned.token.value === "=>") {
      this.#pendingArrow = {
        role: this.scopeRole(activeStepCallId, fanOutCallback),
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

  /**
   * Whether the current token is workflow control flow, where a throw ends the workflow or reaches
   * a workflow `try`. Inside a durable step callback, exceptions are the step's own business.
   */
  isWorkflowControlFlow(): boolean {
    return this.allFunctionScopes().every(
      (scope) => scope.role.kind === "fan-out" || scope.role.kind === "helper",
    );
  }

  allowsWorkflowConstructDiscovery(): boolean {
    return this.allFunctionScopes().every((scope) => scope.role.kind !== "ordinary");
  }

  /** The durable step whose callback directly contains the current token, which owns its returns. */
  directDurableStepCallId(): string | undefined {
    const role = this.allFunctionScopes().at(-1)?.role;
    return role?.kind === "durable-step" ? role.stepCallId : undefined;
  }

  /**
   * The durable step that executes calls at the current token. Fan-out callbacks run inside the
   * enclosing step, so a call in `Promise.all(items.map((item) => tool(item)))` belongs to it.
   */
  invocationStepCallId(): string | undefined {
    for (const scope of this.allFunctionScopes().toReversed()) {
      if (scope.role.kind === "durable-step") {
        return scope.role.stepCallId;
      }
      if (scope.role.kind !== "fan-out") {
        return undefined;
      }
    }
    return undefined;
  }

  shadows(binding: string): boolean {
    const kind = this.binding(binding)?.kind;
    return kind !== undefined && kind !== "context-provider";
  }

  /**
   * Names that refer to a helper's own bindings at the current token, with that helper's id.
   * Inner bindings hide outer ones, so a callback local named like a parameter is not one.
   */
  helperParameterOwners(): Map<string, string> {
    const owners = new Map<string, string | null>();
    for (const name of this.#workflowBindings.keys()) {
      owners.set(name, null);
    }
    for (const scope of this.#activeScopes) {
      for (const name of scope.bindings.keys()) {
        owners.set(name, scope.role.kind === "helper" ? scope.role.helperId : null);
      }
    }
    return new Map(
      [...owners].flatMap(([name, helperId]) => (helperId ? [[name, helperId] as const] : [])),
    );
  }

  helperId(binding: string): string | undefined {
    const resolved = this.binding(binding);
    return resolved?.kind === "helper" ? resolved.helperId : undefined;
  }

  markContextProviderBinding(binding: string): void {
    this.rebind(this.allFunctionScopes(), binding, { kind: "context-provider" });
  }

  /**
   * Turns the function whose body just started into a workflow helper bound to `name`. Only a
   * function written directly in workflow code qualifies; its parameters named like the workflow's
   * step parameter receive that step, because helpers commonly take it explicitly.
   */
  promoteToHelper({
    helperId,
    name,
    declaration,
    stepParameter,
  }: {
    helperId: string;
    name: string;
    declaration: boolean;
    stepParameter: string;
  }): boolean {
    const scope = this.#activeScopes.at(-1);
    const enclosingScopes = this.#activeScopes.slice(0, -1);
    if (
      scope?.role.kind !== "ordinary" ||
      this.#pendingFunctions.length > 0 ||
      this.#pendingArrow !== undefined ||
      enclosingScopes.some((enclosing) => enclosing.role.kind === "ordinary")
    ) {
      return false;
    }

    scope.role = { kind: "helper", helperId };
    scope.bindings.delete(stepParameter);
    const helper: Binding = { kind: "helper", helperId };
    if (declaration) {
      (enclosingScopes.at(-1)?.bindings ?? this.#workflowBindings).set(name, helper);
    } else {
      this.rebind(enclosingScopes, name, helper);
    }
    return true;
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
    this.bindLocal(positioned.token.value);
  }

  private bindLocal(name: string): void {
    const activeScope = this.#activeScopes.at(-1);
    (activeScope?.bindings ?? this.#workflowBindings).set(name, { kind: "local" });
  }

  private binding(name: string): Binding | undefined {
    const scopes = this.allFunctionScopes();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const binding = scopes[index]?.bindings.get(name);
      if (binding) {
        return binding;
      }
    }
    return this.#workflowBindings.get(name);
  }

  private rebind(
    scopes: ReadonlyArray<{ bindings: Map<string, Binding> }>,
    name: string,
    binding: Binding,
  ): void {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index];
      if (scope?.bindings.has(name)) {
        scope.bindings.set(name, binding);
        return;
      }
    }
    if (this.#workflowBindings.has(name)) {
      this.#workflowBindings.set(name, binding);
    }
  }

  private scopeRole(
    activeStepCallId: string | undefined,
    fanOutCallback: boolean,
  ): FunctionScopeRole {
    // The direct callback of each durable step may itself declare nested durable steps.
    // Deeper callbacks (for example `.map()`) return to ordinary JavaScript function semantics,
    // except a fan-out callback, which the workflow runs once per item.
    if (activeStepCallId && !this.claimedDurableStepCallIds().has(activeStepCallId)) {
      return { kind: "durable-step", stepCallId: activeStepCallId };
    }
    return fanOutCallback ? { kind: "fan-out" } : { kind: "ordinary" };
  }

  private claimedDurableStepCallIds(): Set<string> {
    return new Set(
      this.allFunctionScopes().flatMap((scope) =>
        scope.role.kind === "durable-step" ? [scope.role.stepCallId] : [],
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

function activatedScope(scope: ActiveFunctionScope): ActivatedFunctionScope {
  return scope.boundary === "expression"
    ? { boundary: "expression", role: scope.role, baseDepth: { ...scope.baseDepth } }
    : { boundary: "block", role: scope.role, bodyBraces: scope.bodyBraces };
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
): Map<string, Binding> {
  const previous = previousTokens.at(-1);
  if (!previous) {
    return new Map();
  }
  if (previous.token.type === "IdentifierName") {
    return new Map([[previous.token.value, { kind: "local" }]]);
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

  const bindings = new Map<string, Binding>();
  for (const token of parameterTokens) {
    rememberPossibleBinding(bindings, token);
  }
  return bindings;
}

function rememberPossibleBinding(
  bindings: Map<string, Binding>,
  positioned: PositionedWorkflowToken,
): void {
  if (positioned.token.type === "IdentifierName") {
    bindings.set(positioned.token.value, { kind: "local" });
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
    // `for await (...) {` is a loop, not a method named `await`.
    if (methodName.token.value === "await" && precedingValue === "for") {
      return false;
    }
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
