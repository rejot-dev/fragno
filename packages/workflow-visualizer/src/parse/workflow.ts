import {
  type Diagnostic,
  type GraphEdge,
  type GraphNode,
  type LoopNode,
  type StepMeta,
  type StepNode,
  type StepType,
  type WorkflowInputField,
  type WorkflowInputFieldType,
  type WorkflowNode,
  loopNodeId,
  stepNodeId,
  workflowNodeId,
} from "../model.ts";
import {
  type AstNode,
  calleeName,
  childrenOf,
  isNode,
  memberCall,
  memberCallee,
  objectProp,
  objectStringProp,
  parseModule,
  sliceSource,
  sourceRef,
  staticString,
  walkCalls,
} from "./ast.ts";

const STEP_METHODS = new Set<StepType>(["do", "sleep", "sleepUntil", "waitForEvent"]);

export interface FileContribution {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  /** Workflow names this file defines (used for duplicate detection). */
  workflowNames: string[];
}

/**
 * A workflow definition normalized to a single shape, regardless of how it was
 * authored: a `defineWorkflow(...)` call, a bare codemode function, or a
 * `{ name?, run }` object. `optionsArg` is the object carrying an input `schema`
 * (if any), `fn` is the `(event, step) => …` run function, and `refNode` anchors
 * diagnostics + the workflow node to its source position.
 */
interface NormalizedWorkflow {
  name: string;
  remote: boolean;
  optionsArg?: AstNode;
  fn?: AstNode;
  refNode: AstNode;
}

/** Parse a workflow file (`defineWorkflow` or raw codemode) into workflow + step nodes. */
export function parseWorkflowFile(path: string, source: string): FileContribution {
  const { ast, diagnostics } = parseModule(path, source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const workflowNames: string[] = [];
  if (!ast) {
    return { nodes, edges, diagnostics, workflowNames };
  }

  // A file may contain more than one `defineWorkflow(...)` definition; handle each.
  const definitions: NormalizedWorkflow[] = [];
  for (const def of findDefineWorkflowCalls(ast)) {
    const args = (def["arguments"] as AstNode[]) ?? [];
    const name = objectStringProp(args[0], "name");
    if (!name) {
      diagnostics.push({
        severity: "error",
        code: "missing-workflow-name",
        message: "defineWorkflow is missing a static `name`.",
        ref: sourceRef(path, def),
      });
      continue;
    }
    definitions.push({
      name,
      remote: calleeName(def) === "defineRemoteWorkflow",
      optionsArg: args[0],
      fn: isNode(args[1]) ? args[1] : undefined,
      refNode: def,
    });
  }

  // Fall back to a raw codemode workflow — what `execCodeMode` emits — when there
  // were no `defineWorkflow(...)` calls: a bare `async (event, step) => {…}`
  // function, or a `{ name?, run }` definition object. These carry no explicit
  // name, so it is derived from the file path.
  if (definitions.length === 0) {
    const bare = findCodemodeWorkflowExpression(ast);
    if (bare) {
      definitions.push({
        name: bare.name ?? workflowNameFromPath(path),
        remote: false,
        optionsArg: bare.optionsArg,
        fn: bare.fn,
        refNode: bare.refNode,
      });
    }
  }

  if (definitions.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no-workflow",
      message: "No workflow definition found in workflow file.",
      ref: { path },
    });
  }

  for (const def of definitions) {
    const { name, remote } = def;
    const inputSchema = parseInputSchema(def.optionsArg);
    const workflowNode: WorkflowNode = {
      id: workflowNodeId(name),
      kind: "workflow",
      label: name,
      name,
      remote,
      path,
      ref: sourceRef(path, def.refNode),
      ...(inputSchema.length > 0 ? { inputSchema } : {}),
    };
    nodes.push(workflowNode);
    workflowNames.push(name);

    const fn = def.fn;
    const stepParam = fn ? secondParamName(fn) : undefined;
    if (!stepParam || !fn) {
      continue;
    }

    const body = fn["body"];
    if (!isNode(body)) {
      continue;
    }

    const containers = collectContainers(path, source, body, stepParam, name, workflowNode.id);
    nodes.push(...containers);
    edges.push(...containerEdges(containers));
  }

  return { nodes, edges, diagnostics, workflowNames };
}

/** A node that participates in containment/sequencing: a step or a loop block. */
type ContainerChild = StepNode | LoopNode;

/**
 * Emit the structural edges for a workflow's steps and loop blocks:
 *  - `contains` from each container (the workflow, or a loop) to each direct child
 *  - `sequence` between consecutive children sharing the same container
 *
 * Children are grouped by `parentId` and ordered by their source `order`, so each
 * loop body gets its own internal spine and each loop slots into its parent's spine
 * as a single unit.
 */
function containerEdges(children: ContainerChild[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const byParent = new Map<string, ContainerChild[]>();
  for (const child of children) {
    const list = byParent.get(child.parentId) ?? [];
    list.push(child);
    byParent.set(child.parentId, list);
  }
  for (const [parentId, list] of byParent) {
    list.sort((a, b) => a.order - b.order);
    let previousId: string | undefined;
    for (const child of list) {
      edges.push({
        id: `contains:${parentId}->${child.id}`,
        from: parentId,
        to: child.id,
        type: "contains",
      });
      if (previousId) {
        edges.push({
          id: `sequence:${previousId}->${child.id}`,
          from: previousId,
          to: child.id,
          type: "sequence",
        });
      }
      previousId = child.id;
    }
  }
  return edges;
}

// Modifiers that wrap a base Zod type without changing its coarse kind. Used to
// unwrap chains like `z.string().optional().describe("...")` down to `z.string`.
const SCHEMA_MODIFIERS = new Set([
  "optional",
  "nullable",
  "nullish",
  "default",
  "describe",
  "catch",
  "brand",
  "readonly",
  "min",
  "max",
  "email",
  "url",
  "uuid",
  "datetime",
  "int",
  "positive",
  "nonnegative",
  "trim",
]);

const ZOD_TYPE_MAP: Record<string, WorkflowInputFieldType> = {
  string: "string",
  number: "number",
  bigint: "number",
  boolean: "boolean",
  enum: "enum",
  nativeEnum: "enum",
};

/**
 * Parse a `defineWorkflow({ schema: z.object({...}) })` first argument into form
 * field descriptors. Returns [] for anything not statically analyzable (a schema
 * referenced by variable, a non-object schema, etc.) so callers fall back cleanly.
 */
function parseInputSchema(optionsArg: AstNode | undefined): WorkflowInputField[] {
  const schema = optionsArg ? objectProp(optionsArg, "schema") : undefined;
  if (!schema) {
    return [];
  }
  const objectCall = unwrapToObjectCall(schema);
  if (!objectCall) {
    return [];
  }
  const fieldsObj = (objectCall["arguments"] as AstNode[])?.[0];
  if (!isNode(fieldsObj) || fieldsObj.type !== "ObjectExpression") {
    return [];
  }
  const properties = fieldsObj["properties"];
  if (!Array.isArray(properties)) {
    return [];
  }

  const fields: WorkflowInputField[] = [];
  for (const prop of properties) {
    if (!isNode(prop) || prop.type !== "ObjectProperty") {
      continue;
    }
    const keyNode = prop["key"];
    const name =
      isNode(keyNode) && keyNode.type === "Identifier"
        ? (keyNode["name"] as string)
        : staticString(keyNode);
    const value = prop["value"];
    if (!name || !isNode(value)) {
      continue;
    }
    fields.push(parseSchemaField(name, value));
  }
  return fields;
}

/** Find the `z.object(...)` call inside a (possibly chained) schema expression. */
function unwrapToObjectCall(node: AstNode): AstNode | undefined {
  let current: AstNode | undefined = node;
  while (current?.type === "CallExpression") {
    if (memberCallee(current)?.method === "object") {
      return current;
    }
    const member = memberCall(current);
    if (!member) {
      return undefined;
    }
    current = member.object.type === "CallExpression" ? member.object : undefined;
  }
  return undefined;
}

/** Reduce a field schema like `z.string().optional()` to a coarse descriptor. */
function parseSchemaField(name: string, node: AstNode): WorkflowInputField {
  let optional = false;
  let description: string | undefined;
  let enumValues: string[] | undefined;
  let type: WorkflowInputFieldType = "unknown";

  let current: AstNode | undefined = node;
  while (current?.type === "CallExpression") {
    const member = memberCall(current);
    if (!member) {
      break;
    }
    if (member.method === "optional" || member.method === "nullish") {
      optional = true;
    }
    if (member.method === "describe") {
      description = staticString((current["arguments"] as AstNode[])?.[0]) ?? description;
    }
    // Base type reached: `z.<type>(...)` where the object is the `z` identifier.
    if (member.object.type === "Identifier") {
      type = ZOD_TYPE_MAP[member.method] ?? "unknown";
      if (type === "enum") {
        enumValues = parseEnumValues(current);
      }
      break;
    }
    if (!SCHEMA_MODIFIERS.has(member.method)) {
      // An unrecognized wrapper — stop unwrapping but keep what we have.
    }
    current = member.object;
  }

  return {
    name,
    type,
    optional,
    ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
    ...(description ? { description } : {}),
  };
}

/** Extract string members of `z.enum(["a", "b"])`. */
function parseEnumValues(enumCall: AstNode): string[] {
  const arg = (enumCall["arguments"] as AstNode[])?.[0];
  if (!isNode(arg) || arg.type !== "ArrayExpression") {
    return [];
  }
  const elements = arg["elements"];
  if (!Array.isArray(elements)) {
    return [];
  }
  const values: string[] = [];
  for (const element of elements) {
    const value = staticString(element);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

/** A run function is `(event, step) => …` — an arrow/function with ≥2 params. */
function isWorkflowRunFunction(node: unknown): boolean {
  if (!isNode(node)) {
    return false;
  }
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
    return false;
  }
  const params = node["params"];
  return Array.isArray(params) && params.length >= 2;
}

/**
 * Find a raw codemode workflow at the top level — the form `execCodeMode` emits
 * when it isn't wrapped in `defineWorkflow(...)`. Two shapes:
 *   - a bare run function: `async (event, step) => {…}`
 *   - a `{ name?, run }` definition object: `({ name: "x", run: async (e, s) => {} })`
 * Returns the run function, its options object (for an input schema), a static
 * `name` if the object form carries one, and a node to anchor source positions.
 */
function findCodemodeWorkflowExpression(
  root: AstNode,
): { fn: AstNode; optionsArg?: AstNode; name?: string; refNode: AstNode } | undefined {
  const body = root["body"];
  if (!Array.isArray(body)) {
    return undefined;
  }
  for (const stmt of body) {
    if (!isNode(stmt) || stmt.type !== "ExpressionStatement") {
      continue;
    }
    const expr = stmt["expression"];
    if (!isNode(expr)) {
      continue;
    }
    if (isWorkflowRunFunction(expr)) {
      return { fn: expr, refNode: expr };
    }
    if (expr.type === "ObjectExpression") {
      const run = objectProp(expr, "run");
      if (run && isWorkflowRunFunction(run)) {
        return {
          fn: run,
          optionsArg: expr,
          name: objectStringProp(expr, "name"),
          refNode: expr,
        };
      }
    }
  }
  return undefined;
}

/**
 * Derive a workflow name from a file path for anonymous codemode workflows: the
 * basename without its extension chain (`flows/my.workflow.js` -> `my`). Falls
 * back to a generic name so a node is always produced.
 */
function workflowNameFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.split(".")[0] || "workflow";
}

function findDefineWorkflowCalls(root: AstNode): AstNode[] {
  const found: AstNode[] = [];
  const visit = (node: AstNode): void => {
    if (node.type === "CallExpression") {
      const name = calleeName(node);
      if (name === "defineWorkflow" || name === "defineRemoteWorkflow") {
        found.push(node);
      }
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };
  visit(root);
  return found;
}

function secondParamName(fn: AstNode): string | undefined {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") {
    return undefined;
  }
  const params = fn["params"];
  if (!Array.isArray(params) || params.length < 2) {
    return undefined;
  }
  const param = params[1];
  if (isNode(param) && param.type === "Identifier") {
    return param["name"] as string;
  }
  return undefined;
}

/**
 * Walk a workflow's run function into its steps and loop blocks, in source order.
 * Steps and loops share one `order` counter (so ids stay unique and sibling order
 * is preserved) and each carries the `parentId` of its enclosing container — the
 * workflow, or a loop it nests inside. Loops that wrap no steps are pruned, so the
 * graph never carries an empty loop block.
 */
function collectContainers(
  path: string,
  source: string,
  body: AstNode,
  stepParam: string,
  workflowName: string,
  workflowId: string,
): ContainerChild[] {
  const children: ContainerChild[] = [];
  let order = 0;

  walkCalls(body, source, workflowId, {
    onCall: ({ call, branch, parentId }) => {
      const member = memberCallee(call);
      if (!member || member.object !== stepParam) {
        return;
      }
      if (!STEP_METHODS.has(member.method as StepType)) {
        return;
      }

      const stepType = member.method as StepType;
      const args = (call["arguments"] as AstNode[]) ?? [];
      const label = staticString(args[0]) ?? `${stepType} #${order}`;

      children.push({
        id: stepNodeId(workflowName, order),
        kind: "step",
        label,
        stepType,
        workflowName,
        order,
        parentId,
        ref: sourceRef(path, call),
        branch,
        meta: stepMeta(stepType, args),
      });
      order += 1;
    },
    onGuard: ({ test, argument, branch, parentId }) => {
      const condition = sliceSource(source, test);
      const returns = argument ? sliceSource(source, argument) : undefined;
      // The `reason` of a `{ skipped, reason }` bail reads as the human-meaningful
      // label; fall back to a generic "guard" when there's no reason to show.
      const label = objectStringProp(argument, "reason") ?? "guard";

      children.push({
        id: stepNodeId(workflowName, order),
        kind: "step",
        label,
        stepType: "guard",
        workflowName,
        order,
        parentId,
        ref: sourceRef(path, test),
        branch,
        meta: {
          ...(condition ? { condition } : {}),
          ...(returns ? { returns } : {}),
        },
      });
      order += 1;
    },
    onLoop: ({ node, header, loopKind, branch, parentId }) => {
      const id = loopNodeId(workflowName, order);
      children.push({
        id,
        kind: "loop",
        label: header || loopKind,
        loopKind,
        workflowName,
        order,
        parentId,
        branch,
        ref: sourceRef(path, node),
      });
      order += 1;
      return id;
    },
  });

  return pruneEmptyLoops(children);
}

/**
 * Drop loop blocks that (transitively) contain no steps — a loop with nothing to
 * repeat would render as an empty box. Because such a loop has no step descendants,
 * its whole subtree is loops-only and is removed together; no child of a kept node
 * ever points at a removed loop, so no re-parenting is needed.
 */
function pruneEmptyLoops(children: ContainerChild[]): ContainerChild[] {
  const childrenByParent = new Map<string, ContainerChild[]>();
  for (const child of children) {
    const list = childrenByParent.get(child.parentId) ?? [];
    list.push(child);
    childrenByParent.set(child.parentId, list);
  }

  const hasStepDescendant = (loopId: string): boolean => {
    for (const child of childrenByParent.get(loopId) ?? []) {
      if (child.kind === "step") {
        return true;
      }
      if (child.kind === "loop" && hasStepDescendant(child.id)) {
        return true;
      }
    }
    return false;
  };

  return children.filter((child) => child.kind !== "loop" || hasStepDescendant(child.id));
}

function stepMeta(stepType: StepType, args: AstNode[]): StepMeta {
  switch (stepType) {
    case "sleep":
      return { duration: staticString(args[1]) };
    case "sleepUntil":
      return { until: staticString(args[1]) };
    case "waitForEvent":
      return {
        eventType: objectStringProp(args[1], "type"),
        timeout: objectStringProp(args[1], "timeout"),
      };
    case "do":
    case "emit":
    case "guard":
    case "spawn":
      return {};
  }

  throw new Error("Unsupported workflow step type.");
}
