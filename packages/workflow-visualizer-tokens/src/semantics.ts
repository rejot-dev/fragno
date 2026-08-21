import type {
  BranchNode,
  ConditionAnalysis,
  ConditionNode,
  ConditionOutcome,
  ConditionOutcomeCompletion,
  SemanticLiteral,
  SemanticOperand,
  SemanticPredicate,
  SemanticReference,
  WorkflowChildNode,
  WorkflowNode,
} from "./model.ts";
import type { PositionedWorkflowToken } from "./state-machine.ts";
import { staticStringValue, tokenizeWorkflowSource, type WorkflowToken } from "./tokenizer.ts";

/** Add local control-flow meaning without requiring a complete TypeScript program. */
export function analyzeWorkflowConditions({
  workflow,
  children,
  tokens,
}: {
  workflow: WorkflowNode;
  children: WorkflowChildNode[];
  tokens: PositionedWorkflowToken[];
}): void {
  for (const condition of children) {
    if (condition.kind !== "condition") {
      continue;
    }
    condition.analysis = analyzeCondition({ workflow, condition, children, tokens });
  }
}

function analyzeCondition({
  workflow,
  condition,
  children,
  tokens,
}: {
  workflow: WorkflowNode;
  condition: ConditionNode;
  children: WorkflowChildNode[];
  tokens: PositionedWorkflowToken[];
}): ConditionAnalysis {
  if (condition.construction.status === "partial") {
    return { status: "partial", outcomes: [] };
  }

  const bindings = constantReferenceBindingsBefore({ workflow, condition, tokens });
  const predicate = parsePredicate(condition.condition, bindings);
  if (!predicate) {
    return { status: "unsupported", outcomes: [] };
  }

  const outcomes = conditionOutcomes(condition, children, predicate);
  return { status: "complete", predicate, outcomes };
}

function conditionOutcomes(
  condition: ConditionNode,
  children: WorkflowChildNode[],
  predicate: SemanticPredicate,
): ConditionOutcome[] {
  const branches = children.filter(
    (node): node is BranchNode => node.kind === "branch" && node.parentId === condition.id,
  );
  const thenBranch = branches.find((branch) => branch.branchType === "then");
  const elseBranch = branches.find((branch) => branch.branchType === "else");

  if (!thenBranch && !elseBranch) {
    return [
      {
        path: "then",
        predicate,
        completion: completionForContainer(condition.id, children),
      },
      {
        path: "fallthrough",
        predicate: negatePredicate(predicate),
        completion: { kind: "continues" },
      },
    ];
  }

  const outcomes: ConditionOutcome[] = [];
  if (thenBranch) {
    outcomes.push({
      path: "then",
      predicate,
      completion: completionForContainer(thenBranch.id, children),
    });
  }
  if (elseBranch) {
    outcomes.push({
      path: "else",
      predicate: negatePredicate(predicate),
      completion: completionForContainer(elseBranch.id, children),
    });
  } else {
    outcomes.push({
      path: "fallthrough",
      predicate: negatePredicate(predicate),
      completion: { kind: "continues" },
    });
  }
  return outcomes;
}

function completionForContainer(
  parentId: string,
  children: WorkflowChildNode[],
): ConditionOutcomeCompletion {
  const lastChild = children
    .filter((node) => node.parentId === parentId)
    .toSorted((left, right) => left.order - right.order)
    .at(-1);
  return lastChild?.kind === "terminal"
    ? { kind: "terminal", terminalNodeId: lastChild.id }
    : { kind: "continues" };
}

function negatePredicate(predicate: SemanticPredicate): SemanticPredicate {
  switch (predicate.kind) {
    case "comparison":
      return {
        ...predicate,
        operator: predicate.operator === "equals" ? "not-equals" : "equals",
      };
    case "all":
      return combinePredicates("any", predicate.predicates.map(negatePredicate));
    case "any":
      return combinePredicates("all", predicate.predicates.map(negatePredicate));
    case "not":
      return predicate.predicate;
  }
  throw new Error("Unsupported semantic predicate.");
}

function constantReferenceBindingsBefore({
  workflow,
  condition,
  tokens,
}: {
  workflow: WorkflowNode;
  condition: ConditionNode;
  tokens: PositionedWorkflowToken[];
}): Map<string, SemanticReference> {
  const workflowTokens = tokens.filter(
    (token) =>
      token.start >= workflow.source.start.offset && token.start < condition.source.start.offset,
  );
  const scopes: Array<Map<string, SemanticReference>> = [new Map()];

  for (let index = 0; index < workflowTokens.length; index += 1) {
    const token = workflowTokens[index];
    if (token.token.value === "{") {
      scopes.push(new Map());
      continue;
    }
    if (token.token.value === "}") {
      if (scopes.length > 1) {
        scopes.pop();
      }
      continue;
    }
    if (token.token.value !== "const") {
      continue;
    }

    const name = workflowTokens[index + 1];
    const equals = workflowTokens[index + 2];
    if (name?.token.type !== "IdentifierName" || equals?.token.value !== "=") {
      continue;
    }
    const parsed = parseReferenceTokens(workflowTokens, index + 3);
    if (!parsed || workflowTokens[parsed.nextIndex]?.token.value !== ";") {
      continue;
    }

    const currentScope = scopes.at(-1);
    if (!currentScope) {
      throw new Error("Semantic binding analysis requires a lexical scope.");
    }
    const visibleBindings = mergeScopes(scopes);
    currentScope.set(name.token.value, resolveReference(parsed.reference, visibleBindings));
    index = parsed.nextIndex;
  }

  return mergeScopes(scopes);
}

function mergeScopes(
  scopes: Array<Map<string, SemanticReference>>,
): Map<string, SemanticReference> {
  const bindings = new Map<string, SemanticReference>();
  for (const scope of scopes) {
    for (const [name, value] of scope) {
      bindings.set(name, value);
    }
  }
  return bindings;
}

function parseReferenceTokens(
  tokens: PositionedWorkflowToken[],
  startIndex: number,
): { reference: SemanticReference; nextIndex: number } | null {
  const root = tokens[startIndex];
  if (root?.token.type !== "IdentifierName") {
    return null;
  }

  const path: string[] = [];
  let index = startIndex + 1;
  while (tokens[index]?.token.value === "." || tokens[index]?.token.value === "?.") {
    const property = tokens[index + 1];
    if (property?.token.type !== "IdentifierName") {
      return null;
    }
    path.push(property.token.value);
    index += 2;
  }
  return { reference: { kind: "reference", root: root.token.value, path }, nextIndex: index };
}

function resolveReference(
  reference: SemanticReference,
  bindings: Map<string, SemanticReference>,
): SemanticReference {
  const seen = new Set<string>();
  let resolved = reference;
  while (!seen.has(resolved.root)) {
    const binding = bindings.get(resolved.root);
    if (!binding) {
      break;
    }
    seen.add(resolved.root);
    resolved = {
      kind: "reference",
      root: binding.root,
      path: [...binding.path, ...resolved.path],
    };
  }
  return resolved;
}

function parsePredicate(
  source: string,
  bindings: Map<string, SemanticReference>,
): SemanticPredicate | null {
  const tokens = [...tokenizeWorkflowSource(source)].filter(
    (token) =>
      token.type !== "WhiteSpace" &&
      token.type !== "LineTerminatorSequence" &&
      token.type !== "SingleLineComment" &&
      token.type !== "MultiLineComment",
  );
  const parser = new PredicateParser(tokens, bindings);
  const predicate = parser.parse();
  return predicate && parser.atEnd() ? normalizePredicate(predicate) : null;
}

function normalizePredicate(predicate: SemanticPredicate): SemanticPredicate {
  switch (predicate.kind) {
    case "comparison":
      return predicate;
    case "all":
      return combinePredicates("all", predicate.predicates.map(normalizePredicate));
    case "any":
      return combinePredicates("any", predicate.predicates.map(normalizePredicate));
    case "not":
      return negatePredicate(normalizePredicate(predicate.predicate));
  }
  throw new Error("Unsupported semantic predicate.");
}

class PredicateParser {
  readonly #tokens: WorkflowToken[];
  readonly #bindings: Map<string, SemanticReference>;
  #index = 0;

  constructor(tokens: WorkflowToken[], bindings: Map<string, SemanticReference>) {
    this.#tokens = tokens;
    this.#bindings = bindings;
  }

  parse(): SemanticPredicate | null {
    return this.parseAny();
  }

  atEnd(): boolean {
    return this.#index === this.#tokens.length;
  }

  private parseAny(): SemanticPredicate | null {
    const first = this.parseAll();
    if (!first) {
      return null;
    }
    const predicates = [first];
    while (this.consume("||")) {
      const next = this.parseAll();
      if (!next) {
        return null;
      }
      predicates.push(next);
    }
    return combinePredicates("any", predicates);
  }

  private parseAll(): SemanticPredicate | null {
    const first = this.parseUnary();
    if (!first) {
      return null;
    }
    const predicates = [first];
    while (this.consume("&&")) {
      const next = this.parseUnary();
      if (!next) {
        return null;
      }
      predicates.push(next);
    }
    return combinePredicates("all", predicates);
  }

  private parseUnary(): SemanticPredicate | null {
    if (this.consume("!")) {
      const predicate = this.parseUnary();
      return predicate ? { kind: "not", predicate } : null;
    }
    if (this.consume("(")) {
      const predicate = this.parseAny();
      return predicate && this.consume(")") ? predicate : null;
    }
    return this.parseComparison();
  }

  private parseComparison(): SemanticPredicate | null {
    const left = this.parseOperand();
    if (!left) {
      return null;
    }
    const operator = this.current()?.value;
    if (operator !== "===" && operator !== "!==" && operator !== "==" && operator !== "!=") {
      return null;
    }
    this.#index += 1;
    const right = this.parseOperand();
    if (!right) {
      return null;
    }
    return {
      kind: "comparison",
      operator: operator === "===" || operator === "==" ? "equals" : "not-equals",
      left,
      right,
    };
  }

  private parseOperand(): SemanticOperand | null {
    const token = this.current();
    if (!token) {
      return null;
    }

    const stringValue = staticStringValue(token);
    if (stringValue !== undefined) {
      this.#index += 1;
      return { kind: "literal", value: stringValue };
    }
    if (token.type === "NumericLiteral") {
      this.#index += 1;
      const value = Number(token.value.replaceAll("_", ""));
      return Number.isNaN(value) ? null : { kind: "literal", value };
    }
    if (token.type !== "IdentifierName") {
      return null;
    }
    if (token.value === "true" || token.value === "false" || token.value === "null") {
      this.#index += 1;
      return {
        kind: "literal",
        value: token.value === "null" ? null : token.value === "true",
      } satisfies SemanticLiteral;
    }

    const root = token.value;
    this.#index += 1;
    const path: string[] = [];
    while (this.current()?.value === "." || this.current()?.value === "?.") {
      this.#index += 1;
      const property = this.current();
      if (property?.type !== "IdentifierName") {
        return null;
      }
      path.push(property.value);
      this.#index += 1;
    }
    return resolveReference({ kind: "reference", root, path }, this.#bindings);
  }

  private current() {
    return this.#tokens[this.#index];
  }

  private consume(value: string): boolean {
    if (this.current()?.value !== value) {
      return false;
    }
    this.#index += 1;
    return true;
  }
}

function combinePredicates(
  kind: "all" | "any",
  predicates: SemanticPredicate[],
): SemanticPredicate {
  const flattened = predicates.flatMap((predicate) =>
    predicate.kind === kind ? predicate.predicates : [predicate],
  );
  const onlyPredicate = flattened.at(0);
  return flattened.length === 1 && onlyPredicate ? onlyPredicate : { kind, predicates: flattened };
}
