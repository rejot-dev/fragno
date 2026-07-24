export type ConstructionStatus = "partial" | "complete";

export interface ConstructionState<Phase extends string> {
  status: ConstructionStatus;
  phase: Phase;
}

/** Absolute offsets and columns are zero-based; lines are one-based. */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  path: string;
  start: SourcePosition;
  end: SourcePosition;
}

export type WorkflowConstructionPhase =
  | "discovered"
  | "naming"
  | "configured"
  | "body"
  | "complete";

export interface WorkflowNode {
  id: string;
  kind: "workflow";
  label: string;
  name: string;
  remote: boolean;
  path: string;
  source: SourceRange;
  construction: ConstructionState<WorkflowConstructionPhase>;
}

export type StepType = "do" | "sleep" | "sleepUntil" | "waitForEvent";
export type StepConstructionPhase = "discovered" | "labeled" | "complete";

export interface StepMeta {
  duration?: string;
  until?: string;
  eventType?: string;
  timeout?: string;
}

export interface StepNode {
  id: string;
  kind: "step";
  label: string;
  stepType: StepType;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  meta: StepMeta;
  construction: ConstructionState<StepConstructionPhase>;
}

export type ConditionConstructionPhase = "condition" | "branches" | "complete";

export interface SemanticReference {
  kind: "reference";
  root: string;
  path: string[];
}

export interface SemanticLiteral {
  kind: "literal";
  value: string | number | boolean | null;
}

export type SemanticOperand = SemanticReference | SemanticLiteral;

export type SemanticPredicate =
  | {
      kind: "comparison";
      operator: "equals" | "not-equals";
      left: SemanticOperand;
      right: SemanticOperand;
    }
  | { kind: "all"; predicates: SemanticPredicate[] }
  | { kind: "any"; predicates: SemanticPredicate[] }
  | { kind: "not"; predicate: SemanticPredicate };

export type ConditionOutcomePath = "then" | "else" | "fallthrough";

export type ConditionOutcomeCompletion =
  | { kind: "continues" }
  | { kind: "terminal"; terminalNodeId: string };

export interface ConditionOutcome {
  path: ConditionOutcomePath;
  predicate: SemanticPredicate;
  completion: ConditionOutcomeCompletion;
}

export interface SpecificEventGuardAnnotation {
  kind: "specific-event-guard";
  subject: SemanticReference;
  eventSource: string;
  eventType: string;
  acceptedPath: ConditionOutcomePath;
  rejectedTerminalId: string;
  rejectionReason?: string;
}

export type ConditionAnnotation = SpecificEventGuardAnnotation;

export type ConditionAnalysis =
  | { status: "partial"; outcomes: []; annotations: [] }
  | { status: "unsupported"; outcomes: []; annotations: [] }
  | {
      status: "complete";
      predicate: SemanticPredicate;
      outcomes: ConditionOutcome[];
      annotations: ConditionAnnotation[];
    };

export interface ConditionNode {
  id: string;
  kind: "condition";
  label: string;
  condition: string;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  construction: ConstructionState<ConditionConstructionPhase>;
  analysis: ConditionAnalysis;
}

export type LoopType = "for" | "while";
export type LoopConstructionPhase = "header" | "body" | "complete";

export interface LoopNode {
  id: string;
  kind: "loop";
  label: string;
  loopType: LoopType;
  expression: string;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  construction: ConstructionState<LoopConstructionPhase>;
}

export type ParallelStrategy = "all" | "race" | "any";
export type ParallelConstructionPhase = "discovered" | "branches" | "complete";

export interface ParallelNode {
  id: string;
  kind: "parallel";
  label: string;
  strategy: ParallelStrategy;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  construction: ConstructionState<ParallelConstructionPhase>;
}

export type BranchType = "then" | "else" | "parallel";
export type BranchConstructionPhase = "body" | "complete";

export interface BranchNode {
  id: string;
  kind: "branch";
  label: string;
  branchType: BranchType;
  index: number;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  construction: ConstructionState<BranchConstructionPhase>;
}

export type TerminalType = "early-return" | "final-return" | "error";
export type TerminalConstructionPhase = "returning" | "throwing" | "complete";

export interface TerminalNode {
  id: string;
  kind: "terminal";
  label: string;
  terminalType: TerminalType;
  value: string;
  workflowName: string;
  order: number;
  sourceOrder: number;
  parentId: string;
  source: SourceRange;
  construction: ConstructionState<TerminalConstructionPhase>;
}

export type WorkflowChildNode =
  | BranchNode
  | ConditionNode
  | LoopNode
  | ParallelNode
  | StepNode
  | TerminalNode;
export type GraphNode = WorkflowNode | WorkflowChildNode;

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: "contains" | "sequence";
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  source: SourceRange;
}

export interface WorkflowGraph {
  version: 2;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export type GraphPatch =
  | { type: "reset"; graph: WorkflowGraph }
  | { type: "node.upsert"; node: GraphNode }
  | { type: "node.remove"; id: string }
  | { type: "edge.upsert"; edge: GraphEdge }
  | { type: "edge.remove"; id: string }
  | { type: "diagnostics.set"; diagnostics: Diagnostic[] };

export interface DelimiterDepth {
  parentheses: number;
  braces: number;
  brackets: number;
}

export interface ActiveConstruct {
  kind: "workflow" | "parallel" | "step" | "condition" | "loop" | "return" | "throw";
  id: string;
  parentId?: string;
  phase: string;
}

export interface WorkflowMachineState {
  status: "empty" | "tokenizing" | "finished";
  tokenCount: number;
  sourceLength: number;
  delimiterDepth: DelimiterDepth;
  activeConstructs: ActiveConstruct[];
  openToken?: { type: string; start: number };
}

export interface WorkflowVisualizationSnapshot {
  graph: WorkflowGraph;
  state: WorkflowMachineState;
}

export interface WorkflowMachineUpdate extends WorkflowVisualizationSnapshot {
  patches: GraphPatch[];
}
