import { parse } from "@babel/parser";

import type { Diagnostic, LoopKind, SourceRef } from "../model.ts";

/**
 * Loosely typed Babel AST node. We deliberately avoid depending on `@babel/types`:
 * the visitor below only ever reads a handful of well-known fields, and keeping the
 * shape loose lets us tolerate partially-written, error-recovered trees.
 */
export interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

export interface ParseResult {
  ast: AstNode | null;
  diagnostics: Diagnostic[];
}

/**
 * Parse a module with error recovery. Half-written code (the common case while an
 * agent is authoring) still yields a usable tree plus diagnostics, rather than throwing.
 */
export function parseModule(path: string, source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  let ast: AstNode | null = null;
  try {
    const result = parse(source, {
      sourceType: "module",
      errorRecovery: true,
      plugins: [["typescript", {}]],
    });
    ast = result.program as unknown as AstNode;
    for (const error of result.errors ?? []) {
      diagnostics.push(babelErrorToDiagnostic(path, error));
    }
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "parse-error",
      message: error instanceof Error ? error.message : String(error),
      ref: { path },
    });
  }
  return { ast, diagnostics };
}

function babelErrorToDiagnostic(path: string, error: unknown): Diagnostic {
  const err = error as { message?: string; loc?: { line: number; column: number } };
  return {
    severity: "error",
    code: "parse-error",
    message: err.message ?? "Syntax error",
    ref: err.loc ? { path, line: err.loc.line, column: err.loc.column } : { path },
  };
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "type",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "range",
]);

/** Direct child AST nodes, in declaration order (which matches source order for body arrays). */
export function childrenOf(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    const value = node[key];
    if (isNode(value)) {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          out.push(item);
        }
      }
    }
  }
  return out;
}

export interface CallVisit {
  call: AstNode;
  /** Raw text of `if` conditions enclosing the call *within its container*, outer-to-inner. */
  branch: string[];
  /** Id of the enclosing container — the root container, or an enclosing loop. */
  parentId: string;
}

export interface GuardVisit {
  /** The `if (...)` test node that triggers the early return. */
  test: AstNode;
  /** The returned value node, or undefined for a bare `return;`. */
  argument?: AstNode;
  /** Raw text of *enclosing* `if` conditions within the container, outer-to-inner. */
  branch: string[];
  /** Id of the enclosing container — the root container, or an enclosing loop. */
  parentId: string;
}

export interface LoopVisit {
  /** The loop statement node. */
  node: AstNode;
  /** Header text of the loop, e.g. `for (const x of items)`. */
  header: string;
  loopKind: LoopKind;
  /** Raw text of `if` conditions enclosing the loop *within its container*, outer-to-inner. */
  branch: string[];
  /** Id of the container the loop sits in — the root container, or an outer loop. */
  parentId: string;
}

export interface WalkHandlers {
  onCall: (visit: CallVisit) => void;
  onGuard?: (visit: GuardVisit) => void;
  /**
   * Invoked when entering a loop in the (non-callback) control flow. Must return
   * the id assigned to the loop, which becomes the `parentId` of everything in
   * the loop body, so loop nesting is reconstructed structurally.
   */
  onLoop?: (visit: LoopVisit) => string;
}

/**
 * Walk the tree depth-first, invoking `onCall` for every CallExpression. Tracks two
 * kinds of context so the model can reconstruct control flow:
 *
 *  - branch: descending into an `if` consequent/alternate pushes the (negated)
 *    condition text, so each call/guard/loop knows which conditions gate it.
 *  - container: each call/guard/loop is tagged with the id of the container it
 *    lives in. The container is `rootParentId` at the top level, or an enclosing
 *    loop's id inside a loop body. Entering a loop calls `onLoop` (which mints the
 *    loop's id) and *resets* the branch context — conditions gating the loop are
 *    reported on the loop, conditions inside its body on the body's contents.
 *
 * When `onGuard` is given, an `if` whose consequent returns early — `if (cond) return x;`
 * or `if (cond) { ...; return x; }` — is reported as a guard at its source position, so
 * callers can interleave guards with calls in order.
 *
 * Loops (`for` / `for…in` / `for…of` / `while` / `do…while`) only become container
 * blocks when `onLoop` is given and they sit in the workflow's own control flow;
 * loops inside a `step.do(...)` callback are the step's logic, not workflow flow.
 */
export function walkCalls(
  root: AstNode,
  source: string,
  rootParentId: string,
  handlers: WalkHandlers,
): void {
  const { onCall, onGuard, onLoop } = handlers;
  const visit = (node: AstNode, branch: string[], parentId: string, inFunction: boolean): void => {
    if (node.type === "IfStatement") {
      const test = node["test"];
      const consequent = node["consequent"];
      const alternate = node["alternate"];
      const condition = isNode(test) ? sliceSource(source, test) : "";
      // Guards belong to the *workflow's* control flow, so ignore early returns
      // nested inside a `step.do(...)` callback (`inFunction`) — those are the
      // step's own logic, not a workflow-level bail.
      if (onGuard && !inFunction && isNode(test) && isNode(consequent)) {
        const ret = guardReturn(consequent);
        if (ret) {
          const argument = ret["argument"];
          onGuard({ test, argument: isNode(argument) ? argument : undefined, branch, parentId });
        }
      }
      if (isNode(test)) {
        visit(test, branch, parentId, inFunction);
      }
      if (isNode(consequent)) {
        visit(consequent, condition ? [...branch, condition] : branch, parentId, inFunction);
      }
      if (isNode(alternate)) {
        visit(alternate, condition ? [...branch, `!(${condition})`] : branch, parentId, inFunction);
      }
      return;
    }

    // A loop in the workflow's own control flow becomes a container block: mint
    // its id, then visit its *body* re-parented to that loop with a fresh branch
    // context. Loops inside callbacks (`inFunction`) are skipped — they are the
    // step's internal logic, not workflow flow.
    if (LOOP_TYPES.has(node.type) && onLoop && !inFunction) {
      const header = loopHeader(source, node);
      const loopId = onLoop({ node, header, loopKind: LOOP_KIND[node.type], branch, parentId });
      const body = node["body"];
      // Only the loop *body* repeats and nests under the loop; its head
      // (init/test/iterable) runs in the enclosing container and scope.
      for (const child of childrenOf(node)) {
        const isBody = isNode(body) && child === body;
        if (isBody) {
          visit(child, [], loopId, false);
        } else {
          visit(child, branch, parentId, inFunction || FUNCTION_TYPES.has(child.type));
        }
      }
      return;
    }

    if (node.type === "CallExpression") {
      onCall({ call: node, branch, parentId });
    }

    for (const child of childrenOf(node)) {
      visit(child, branch, parentId, inFunction || FUNCTION_TYPES.has(child.type));
    }
  };

  visit(root, [], rootParentId, false);
}

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
]);

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const LOOP_KIND: Record<string, LoopKind> = {
  ForStatement: "for",
  ForInStatement: "forIn",
  ForOfStatement: "forOf",
  WhileStatement: "while",
  DoWhileStatement: "doWhile",
};

/** Readable header text for a loop, e.g. `for (const x of items)` or `while (cond)`. */
function loopHeader(source: string, node: AstNode): string {
  if (node.type === "DoWhileStatement") {
    const test = node["test"];
    const cond = isNode(test) ? sliceSource(source, test) : "";
    return cond ? `do…while (${cond})` : "do…while";
  }
  // `for`/`for…of`/`for…in`/`while`: everything up to the body is the header.
  const body = node["body"];
  if (isNode(body) && typeof node.start === "number" && typeof body.start === "number") {
    return source.slice(node.start, body.start).trim();
  }
  return "";
}

/**
 * The early-return `ReturnStatement` an `if` guards on, if it's a *pure* guard:
 * `if (cond) return x;` or `if (cond) { return x; }`. A consequent that does other
 * work before returning is a regular branch (its steps already carry the condition
 * as a branch annotation), not a guard.
 */
function guardReturn(consequent: AstNode): AstNode | undefined {
  if (consequent.type === "ReturnStatement") {
    return consequent;
  }
  if (consequent.type === "BlockStatement") {
    const body = consequent["body"];
    if (
      Array.isArray(body) &&
      body.length === 1 &&
      isNode(body[0]) &&
      body[0].type === "ReturnStatement"
    ) {
      return body[0];
    }
  }
  return undefined;
}

export function sliceSource(source: string, node: AstNode): string {
  if (typeof node.start === "number" && typeof node.end === "number") {
    return source.slice(node.start, node.end).trim();
  }
  return "";
}

export function sourceRef(path: string, node: AstNode): SourceRef {
  if (node.loc) {
    return { path, line: node.loc.start.line, column: node.loc.start.column };
  }
  return { path };
}

/** Callee identifier name for `foo(...)`, or undefined for member/other callees. */
export function calleeName(call: AstNode): string | undefined {
  const callee = call["callee"];
  if (isNode(callee) && callee.type === "Identifier") {
    return callee["name"] as string;
  }
  return undefined;
}

/** For `obj.method(...)`, returns `{ object, method }` when both are simple identifiers. */
export function memberCallee(call: AstNode): { object: string; method: string } | undefined {
  const callee = call["callee"];
  if (!isNode(callee) || callee.type !== "MemberExpression") {
    return undefined;
  }
  const object = callee["object"];
  const property = callee["property"];
  if (!isNode(object) || object.type !== "Identifier") {
    return undefined;
  }
  if (!isNode(property) || property.type !== "Identifier") {
    return undefined;
  }
  return { object: object["name"] as string, method: property["name"] as string };
}

/** Static string value of a node: string literals and zero-expression template literals. */
export function staticString(node: unknown): string | undefined {
  if (!isNode(node)) {
    return undefined;
  }
  if (node.type === "StringLiteral") {
    return node["value"] as string;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = node["expressions"];
    const quasis = node["quasis"];
    if (
      Array.isArray(expressions) &&
      expressions.length === 0 &&
      Array.isArray(quasis) &&
      quasis.length === 1
    ) {
      const quasi = quasis[0] as AstNode;
      const value = quasi["value"] as { cooked?: string } | undefined;
      return value?.cooked;
    }
  }
  return undefined;
}

/** Read a property's *value node* from an ObjectExpression (any value type). */
export function objectProp(objectExpr: unknown, key: string): AstNode | undefined {
  if (!isNode(objectExpr) || objectExpr.type !== "ObjectExpression") {
    return undefined;
  }
  const properties = objectExpr["properties"];
  if (!Array.isArray(properties)) {
    return undefined;
  }
  for (const prop of properties) {
    if (!isNode(prop) || prop.type !== "ObjectProperty") {
      continue;
    }
    const keyNode = prop["key"];
    const name = isNode(keyNode)
      ? keyNode.type === "Identifier"
        ? (keyNode["name"] as string)
        : staticString(keyNode)
      : undefined;
    if (name === key) {
      const value = prop["value"];
      return isNode(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * For `obj.method(...)` where `obj` may itself be any node (not only an
 * identifier), returns the method name and the object node — so chained calls
 * like `z.string().optional()` can be unwrapped one level at a time.
 */
export function memberCall(call: AstNode): { method: string; object: AstNode } | undefined {
  const callee = call["callee"];
  if (!isNode(callee) || callee.type !== "MemberExpression") {
    return undefined;
  }
  const property = callee["property"];
  const object = callee["object"];
  if (!isNode(property) || property.type !== "Identifier" || !isNode(object)) {
    return undefined;
  }
  return { method: property["name"] as string, object };
}

/** Read a string-valued property from an ObjectExpression argument. */
export function objectStringProp(objectExpr: unknown, key: string): string | undefined {
  if (!isNode(objectExpr) || objectExpr.type !== "ObjectExpression") {
    return undefined;
  }
  const properties = objectExpr["properties"];
  if (!Array.isArray(properties)) {
    return undefined;
  }
  for (const prop of properties) {
    if (!isNode(prop) || prop.type !== "ObjectProperty") {
      continue;
    }
    const keyNode = prop["key"];
    const name = isNode(keyNode)
      ? keyNode.type === "Identifier"
        ? (keyNode["name"] as string)
        : staticString(keyNode)
      : undefined;
    if (name === key) {
      return staticString(prop["value"]);
    }
  }
  return undefined;
}
