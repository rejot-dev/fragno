import { createWorkflowTokenMachine } from "./machine.ts";
import type { WorkflowVisualizationSnapshot } from "./model.ts";
import { tokenizeWorkflowSource } from "./tokenizer.ts";

export { createWorkflowTokenMachine, diffGraph } from "./machine.ts";
export type { CreateWorkflowTokenMachineOptions, WorkflowTokenMachine } from "./machine.ts";

export { TokenSubmachineRuntime } from "./state-machine.ts";
export type {
  PositionedWorkflowToken,
  TokenMachineContext,
  TokenSubmachine,
  TokenSubmachineStatus,
} from "./state-machine.ts";

export {
  renderWorkflowGraphText,
  renderWorkflowMachineDebugText,
  renderWorkflowVisualizationText,
} from "./text.ts";

export {
  isTriviaToken,
  staticStringValue,
  tokenizeWorkflowSource,
  tokenIsOpen,
} from "./tokenizer.ts";
export type { WorkflowToken } from "./tokenizer.ts";

export type {
  ActiveConstruct,
  BranchConstructionPhase,
  BranchNode,
  BranchType,
  ConditionAnalysis,
  ConditionAnnotation,
  ConditionConstructionPhase,
  ConditionNode,
  ConditionOutcome,
  ConditionOutcomeCompletion,
  ConditionOutcomePath,
  ConstructionState,
  ConstructionStatus,
  Diagnostic,
  DiagnosticSeverity,
  DelimiterDepth,
  GraphEdge,
  GraphNode,
  GraphPatch,
  LoopConstructionPhase,
  LoopNode,
  LoopType,
  ParallelConstructionPhase,
  ParallelNode,
  ParallelStrategy,
  SemanticLiteral,
  SemanticOperand,
  SemanticPredicate,
  SemanticReference,
  SourcePosition,
  SourceRange,
  SpecificEventGuardAnnotation,
  StepConstructionPhase,
  StepMeta,
  StepNode,
  StepType,
  TerminalConstructionPhase,
  TerminalNode,
  TerminalType,
  WorkflowChildNode,
  WorkflowConstructionPhase,
  WorkflowGraph,
  WorkflowMachineState,
  WorkflowMachineUpdate,
  WorkflowNode,
  WorkflowVisualizationSnapshot,
} from "./model.ts";

/** Tokenize and visualize a complete or half-written workflow source in one call. */
export function visualizeWorkflowSource(
  path: string,
  source: string,
  options?: { fallbackName?: string; finish?: boolean },
): WorkflowVisualizationSnapshot {
  const machine = createWorkflowTokenMachine({ path, fallbackName: options?.fallbackName });
  machine.pushAll(tokenizeWorkflowSource(source));
  return options?.finish === false ? machine.snapshot() : machine.finish();
}
