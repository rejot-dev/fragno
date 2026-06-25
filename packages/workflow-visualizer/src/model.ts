/**
 * The JSON model emitted by the workflow visualizer.
 *
 * The graph describes the full Fragno automation pipeline derived statically from source:
 *
 *   event (capability descriptor)
 *     --matches--> router (a `workflow.createInstance` / `workflow.sendEvent` rule)
 *     --spawns-->  workflow (`defineWorkflow` / `defineRemoteWorkflow`)
 *     --contains--> step (`step.do` / `sleep` / `sleepUntil` / `waitForEvent`)
 *     --sequence--> step ...
 *
 * Everything here is plain JSON: no functions, no class instances. It is safe to
 * `JSON.stringify` a {@link WorkflowGraph} or a {@link GraphPatch} and ship it to a browser.
 */

export type NodeKind = "event" | "router" | "script" | "workflow" | "loop" | "step";

/** A pointer back into the source file a node was derived from. */
export interface SourceRef {
  /** File path as passed to the interpreter (e.g. `automations/router.cm.js`). */
  path: string;
  /** 1-based line, when known. */
  line?: number;
  /** 0-based column, when known. */
  column?: number;
}

/** A declared automation event a capability can emit. Entry point of the pipeline. */
export interface EventNode {
  id: string;
  kind: "event";
  label: string;
  source: string;
  eventType: string;
  scope?: string;
  description?: string;
}

/** Conditions a router rule matched on, extracted from the enclosing `if` tests. */
export interface RouterMatch {
  /** `event.source === "..."` extracted from the branch conditions, when present. */
  source?: string;
  /** `event.eventType === "..."` extracted from the branch conditions, when present. */
  eventType?: string;
  /** Raw text of every enclosing condition, in outer-to-inner order. */
  conditions: string[];
}

/** A single routing decision inside a router script. */
export interface RouterNode {
  id: string;
  kind: "router";
  label: string;
  /** `spawn` = `workflow.createInstance`, `sendEvent` = `workflow.sendEvent`. */
  action: "spawn" | "sendEvent";
  path: string;
  ref?: SourceRef;
  match: RouterMatch;
  /** Target workflow name for `spawn` rules (the `remoteWorkflowName`). */
  targetWorkflowName?: string;
  /** Durable event type for `sendEvent` rules. */
  eventType?: string;
}

/** An automation script that is neither the router nor a workflow definition. */
export interface ScriptNode {
  id: string;
  kind: "script";
  label: string;
  engine: "bash" | "codemode";
  path: string;
  enabled: boolean;
}

/** Coarse field type extracted from a `z.object({...})` input schema literal. */
export type WorkflowInputFieldType = "string" | "number" | "boolean" | "enum" | "unknown";

/** One field of a workflow's declared input schema, for form rendering. */
export interface WorkflowInputField {
  name: string;
  type: WorkflowInputFieldType;
  optional: boolean;
  /** Allowed values for `enum` fields. */
  enumValues?: string[];
  /** `.describe("...")` text, when present. */
  description?: string;
}

/** A workflow definition. */
export interface WorkflowNode {
  id: string;
  kind: "workflow";
  label: string;
  name: string;
  remote: boolean;
  path: string;
  ref?: SourceRef;
  /**
   * Fields parsed from the `defineWorkflow({ schema: z.object({...}) })` literal,
   * when the schema is a statically-analyzable Zod object. Absent otherwise.
   */
  inputSchema?: WorkflowInputField[];
}

/** The kind of loop a {@link LoopNode} was derived from. */
export type LoopKind = "for" | "forIn" | "forOf" | "while" | "doWhile";

/**
 * A loop in a workflow's control flow, surfaced as a *container* block: every
 * step (or nested loop) that repeats inside it is parented to this node via its
 * `parentId`, so the visualizer can draw the loop body nested inside the loop.
 */
export interface LoopNode {
  id: string;
  kind: "loop";
  /** Header text of the loop, e.g. `for (const repo of event.payload.repos)`. */
  label: string;
  loopKind: LoopKind;
  workflowName: string;
  /**
   * 0-based position in source order within the whole workflow. Doubles as the
   * sort key among siblings (children sharing a `parentId`).
   */
  order: number;
  /** Enclosing container: the workflow id, or an enclosing loop's id. */
  parentId: string;
  /**
   * Branch annotations: the raw text of every `if` condition between this loop's
   * parent container and the loop itself, outer-to-inner. Empty when the loop is
   * entered unconditionally.
   */
  branch: string[];
  ref?: SourceRef;
}

export type StepType = "do" | "sleep" | "sleepUntil" | "waitForEvent" | "emit" | "spawn" | "guard";

/** Extra, step-type specific details surfaced for visualization. */
export interface StepMeta {
  /** `step.sleep` duration literal (e.g. `"3 seconds"`). */
  duration?: string;
  /** `step.sleepUntil` raw target expression. */
  until?: string;
  /** `step.waitForEvent` `type`. */
  eventType?: string;
  /** `step.waitForEvent` `timeout` literal. */
  timeout?: string;
  /**
   * `guard` test expression — the raw `if (...)` condition that triggers the
   * early return (e.g. `text !== "/test"`).
   */
  condition?: string;
  /** `guard` return value — raw text of what the workflow returns when it bails (e.g. `{ skipped: true, reason: "..." }`). */
  returns?: string;
}

/** A single step within a workflow, in source order. */
export interface StepNode {
  id: string;
  kind: "step";
  label: string;
  stepType: StepType;
  workflowName: string;
  /** 0-based position within the workflow, in source order. */
  order: number;
  /**
   * Enclosing container: the workflow id, or the id of a {@link LoopNode} when
   * the step repeats inside a loop. Loop nesting is structural (a step in a loop
   * is parented to that loop), so there is no per-step loop annotation.
   */
  parentId: string;
  ref?: SourceRef;
  /**
   * Branch annotations: the raw text of every `if` condition between this step's
   * parent container and the step itself, outer-to-inner. Empty when the step
   * runs unconditionally within its container.
   */
  branch: string[];
  meta: StepMeta;
}

export type GraphNode = EventNode | RouterNode | ScriptNode | WorkflowNode | LoopNode | StepNode;

export type EdgeType =
  | "matches" // event -> router
  | "spawns" // router -> workflow
  | "contains" // container (workflow / loop) -> child (loop / step)
  | "sequence" // sibling -> next sibling (within the same container)
  | "sends" // router (sendEvent) -> workflow (that waits for the event)
  | "waits" // step (waitForEvent) -> event
  | "emits"; // step -> event

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  ref?: SourceRef;
  /** Stable machine code, e.g. `parse-error`, `unknown-workflow`. */
  code?: string;
}

/** A materialized snapshot of the whole pipeline. */
export interface WorkflowGraph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/**
 * An incremental update emitted as source changes. `reset` carries a full snapshot
 * (sent to every new subscriber); the rest are fine-grained deltas.
 */
export type GraphPatch =
  | { type: "reset"; graph: WorkflowGraph }
  | { type: "node.upsert"; node: GraphNode }
  | { type: "node.remove"; id: string }
  | { type: "edge.upsert"; edge: GraphEdge }
  | { type: "edge.remove"; id: string }
  | { type: "diagnostics.set"; diagnostics: Diagnostic[] };

/** A declared automation event, supplied to the interpreter as structured data. */
export interface EventDescriptor {
  source: string;
  eventType: string;
  label?: string;
  description?: string;
  scope?: string;
}

export function eventNodeId(source: string, eventType: string): string {
  return `event:${source}/${eventType}`;
}

export function workflowNodeId(name: string): string {
  return `workflow:${name}`;
}

export function stepNodeId(workflowName: string, order: number): string {
  return `step:${workflowName}#${order}`;
}

export function loopNodeId(workflowName: string, order: number): string {
  return `loop:${workflowName}#${order}`;
}

export function scriptNodeId(path: string): string {
  return `script:${path}`;
}
