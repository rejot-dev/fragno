import { WorkflowFunctionScopeTracker } from "./function-scope.ts";
import type {
  ConditionAnalysis,
  ConditionNode,
  Diagnostic,
  GraphEdge,
  GraphPatch,
  LoopNode,
  LoopType,
  ParallelNode,
  ParallelStrategy,
  SemanticPredicate,
  SourceRange,
  StepMeta,
  StepNode,
  StepType,
  TerminalNode,
  TerminalType,
  WorkflowGraph,
  WorkflowMachineState,
  WorkflowMachineUpdate,
  WorkflowNode,
  WorkflowVisualizationSnapshot,
  WorkflowChildNode,
} from "./model.ts";
import { analyzeWorkflowConditions } from "./semantics.ts";
import { cloneSourceRange, sourceRangeAtOffset, sourceRangeFromToken } from "./source-location.ts";
import {
  type PositionedWorkflowToken,
  type TokenMachineContext,
  TokenSubmachineRuntime,
} from "./state-machine.ts";
import {
  IfStatementMachine,
  LoopStatementMachine,
  ParallelCallMachine,
  ReturnStatementMachine,
  StepCallMachine,
  ThrowStatementMachine,
  type WorkflowBuilder,
  WorkflowDefinitionMachine,
  isIfStatementMachine,
  isLoopStatementMachine,
  isParallelCallMachine,
  isReturnStatementMachine,
  isStepCallMachine,
  isThrowStatementMachine,
  isWorkflowDefinitionMachine,
} from "./submachines.ts";
import type { WorkflowToken } from "./tokenizer.ts";
import { isTriviaToken, tokenIsOpen } from "./tokenizer.ts";

const STEP_METHODS = new Set<StepType>(["do", "sleep", "sleepUntil", "waitForEvent"]);

export interface CreateWorkflowTokenMachineOptions {
  path: string;
  fallbackName?: string;
}

export interface WorkflowTokenMachine {
  /**
   * Ingest one token and immediately materialize and diff the graph.
   * Prefer `pushAll()` for large inputs when intermediate token states are not rendered.
   */
  push(token: WorkflowToken): WorkflowMachineUpdate;
  /** Ingest a token batch and materialize, diff, and publish the graph once. */
  pushAll(tokens: Iterable<WorkflowToken>): WorkflowMachineUpdate;
  finish(): WorkflowMachineUpdate;
  snapshot(): WorkflowVisualizationSnapshot;
  source(): string;
  onPatch(listener: (patch: GraphPatch) => void): () => void;
}

/** Coordinates token positioning, construct discovery, submachines, and graph materialization. */
export function createWorkflowTokenMachine({
  path,
  fallbackName = workflowNameFromPath(path),
}: CreateWorkflowTokenMachineOptions): WorkflowTokenMachine {
  let source = "";
  let tokenCount = 0;
  let line = 1;
  let column = 0;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let finished = false;
  let openToken: { type: string; start: number } | undefined;
  let currentGraph: WorkflowGraph = emptyGraph();

  const significantTokens: PositionedWorkflowToken[] = [];
  const workflows: WorkflowBuilder[] = [];
  const lexicalDiagnostics: Diagnostic[] = [];
  const functionScopesByWorkflowId = new Map<string, WorkflowFunctionScopeTracker>();
  const runtime = new TokenSubmachineRuntime();
  const listeners = new Set<(patch: GraphPatch) => void>();

  function push(token: WorkflowToken): WorkflowMachineUpdate {
    ingestToken(token);
    return commit();
  }

  function pushAll(tokens: Iterable<WorkflowToken>): WorkflowMachineUpdate {
    let ingestedToken = false;
    for (const token of tokens) {
      ingestToken(token);
      ingestedToken = true;
    }
    return ingestedToken ? commit() : { ...snapshot(), patches: [] };
  }

  function ingestToken(token: WorkflowToken): void {
    finished = false;
    const positioned = positionToken(token);

    if (tokenIsOpen(token)) {
      openToken = { type: token.type, start: positioned.start };
    }
    if (token.type === "Invalid") {
      lexicalDiagnostics.push({
        severity: "warning",
        code: "invalid-token",
        message: `Unrecognized token ${JSON.stringify(token.value)}.`,
        source: sourceRangeFromToken(path, positioned),
      });
    }

    if (!isTriviaToken(token)) {
      processSignificantToken(positioned);
      significantTokens.push(positioned);
    }
  }

  function finish(): WorkflowMachineUpdate {
    finished = true;
    runtime.finish(machineContext());
    return commit();
  }

  function snapshot(): WorkflowVisualizationSnapshot {
    return { graph: cloneGraph(currentGraph), state: machineState() };
  }

  function positionToken(token: WorkflowToken): PositionedWorkflowToken {
    const endPosition = positionAfterText(line, column, token.value);
    const positioned: PositionedWorkflowToken = {
      token,
      start: source.length,
      end: source.length + token.value.length,
      line,
      column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
    };
    source += token.value;
    tokenCount += 1;
    line = endPosition.line;
    column = endPosition.column;
    return positioned;
  }

  function processSignificantToken(positioned: PositionedWorkflowToken): void {
    const context = machineContext();
    runtime.consume(positioned, context);

    const workflowMachine = activeWorkflowMachine(context);
    const functionScopes = workflowMachine
      ? functionScopesByWorkflowId.get(workflowMachine.id)
      : undefined;
    functionScopes?.beforeToken(positioned, context);

    if (!functionScopes?.isNestedFunction()) {
      if (positioned.token.value === "return") {
        discoverReturn(positioned, context);
      } else if (positioned.token.value === "throw") {
        discoverThrow(positioned, context);
      }
    }
    if (
      positioned.token.value === "(" &&
      (functionScopes?.allowsWorkflowConstructDiscovery() ?? true)
    ) {
      discoverParenthesizedConstruct(positioned, context, functionScopes);
    }

    functionScopes?.afterToken({
      positioned,
      context,
      previousTokens: significantTokens,
      activeStepCallId: runtime.findLast(isStepCallMachine)?.id,
    });
    updateDelimiterDepth(positioned.token.value);
  }

  function discoverReturn(positioned: PositionedWorkflowToken, context: TokenMachineContext): void {
    if (runtime.has(isStepCallMachine)) {
      return;
    }
    const workflowMachine = activeWorkflowMachine(context);
    if (!workflowMachine) {
      return;
    }

    const conditions = activeConditionMachines(workflowMachine.workflow);
    const condition = conditions.at(-1);
    const loop = activeLoopMachines(workflowMachine.workflow).at(-1);
    const parentId =
      condition?.activeContainerId() ??
      activeContainerId(workflowMachine.workflow) ??
      workflowMachine.id;
    const isEarlyReturn = condition !== undefined || loop !== undefined;
    const terminal = createTerminalNode({
      workflow: workflowMachine.workflow,
      terminalType: isEarlyReturn ? "early-return" : "final-return",
      label: isEarlyReturn ? "early return" : "return",
      parentId,
      source: sourceRangeFromToken(path, positioned),
      phase: "returning",
    });
    for (const activeCondition of conditions) {
      if (activeCondition === condition) {
        activeCondition.markAbruptCompletion(terminal.id);
      } else {
        activeCondition.markContainsStep();
      }
    }
    runtime.add(
      new ReturnStatementMachine({
        id: `${terminal.id}/return`,
        parentId: condition?.id ?? parentId,
        terminal,
        statement: positioned,
        baseDepth: context.depth,
      }),
    );
  }

  function discoverThrow(positioned: PositionedWorkflowToken, context: TokenMachineContext): void {
    if (runtime.has(isStepCallMachine)) {
      return;
    }
    const workflowMachine = activeWorkflowMachine(context);
    if (!workflowMachine) {
      return;
    }

    const conditions = activeConditionMachines(workflowMachine.workflow);
    const condition = conditions.at(-1);
    const parentId =
      condition?.activeContainerId() ??
      activeContainerId(workflowMachine.workflow) ??
      workflowMachine.id;
    const terminal = createTerminalNode({
      workflow: workflowMachine.workflow,
      terminalType: "error",
      label: "error",
      parentId,
      source: sourceRangeFromToken(path, positioned),
      phase: "throwing",
    });
    for (const activeCondition of conditions) {
      if (activeCondition === condition) {
        activeCondition.markAbruptCompletion(terminal.id);
      } else {
        activeCondition.markContainsStep();
      }
    }
    runtime.add(
      new ThrowStatementMachine({
        id: `${terminal.id}/throw`,
        parentId: condition?.id ?? parentId,
        terminal,
        expressionStart: positioned.end,
        baseDepth: context.depth,
      }),
    );
  }

  function discoverParenthesizedConstruct(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
    functionScopes: WorkflowFunctionScopeTracker | undefined,
  ): void {
    const previous = significantTokens.at(-1);
    if (!previous) {
      return;
    }

    const workflowDefinitionKind = directWorkflowDefinitionKind(significantTokens);
    if (workflowDefinitionKind && !functionScopes?.isNestedFunction()) {
      discoverWorkflow(positioned, previous, workflowDefinitionKind === "remote", context);
      return;
    }

    const workflowMachine = activeWorkflowMachine(context);
    if (!workflowMachine) {
      return;
    }

    if (previous.token.value === "if") {
      discoverCondition(positioned, workflowMachine, context);
      return;
    }

    const loopType = directLoopType(significantTokens);
    if (loopType) {
      discoverLoop(positioned, loopType, workflowMachine, context);
      return;
    }

    const parallelCall = directPromiseCombinator(significantTokens);
    if (parallelCall) {
      discoverParallel(parallelCall.object, parallelCall.strategy, workflowMachine, context);
      return;
    }

    const stepCall = directStepCall(significantTokens, workflowMachine.stepParameter);
    if (!stepCall || functionScopes?.shadows(workflowMachine.stepParameter)) {
      return;
    }

    discoverStep(positioned, stepCall.object, stepCall.method, workflowMachine, context);
  }

  function discoverWorkflow(
    openingParenthesis: PositionedWorkflowToken,
    callee: PositionedWorkflowToken,
    remote: boolean,
    context: TokenMachineContext,
  ): void {
    const ordinal = workflows.length;
    const name = ordinal === 0 ? fallbackName : `${fallbackName}-${ordinal + 1}`;
    const id = `workflow-source:${path}#${ordinal}`;
    const workflow: WorkflowBuilder = {
      node: {
        id,
        kind: "workflow",
        label: name,
        name,
        remote,
        path,
        source: sourceRangeFromToken(path, callee),
        construction: { status: "partial", phase: "discovered" },
      },
      hasSourceName: false,
      nextNodeOrdinal: 0,
      children: [],
    };
    workflows.push(workflow);
    functionScopesByWorkflowId.set(id, new WorkflowFunctionScopeTracker());
    runtime.add(
      new WorkflowDefinitionMachine({
        workflow,
        openParentheses: context.depth.parentheses + 1,
        baseBraces: context.depth.braces,
        baseBrackets: context.depth.brackets,
        argumentStart: openingParenthesis.end,
      }),
    );
  }

  function discoverLoop(
    openingParenthesis: PositionedWorkflowToken,
    loopType: LoopType,
    workflowMachine: WorkflowDefinitionMachine,
    context: TokenMachineContext,
  ): void {
    const conditions = activeConditionMachines(workflowMachine.workflow);
    const parentId = activeContainerId(workflowMachine.workflow) ?? workflowMachine.id;
    const ordinal = nextNodeOrdinal(workflowMachine.workflow);
    const loopKeyword =
      significantTokens.at(-1)?.token.value === "await"
        ? significantTokens.at(-2)
        : significantTokens.at(-1);
    const loop: LoopNode = {
      id: `${workflowMachine.id}/loop#${ordinal}`,
      kind: "loop",
      label: loopType,
      loopType,
      expression: "",
      workflowName: workflowMachine.workflow.node.name,
      order: nextChildOrder(workflowMachine.workflow, parentId),
      sourceOrder: ordinal,
      parentId,
      source: sourceRangeFromToken(path, loopKeyword ?? openingParenthesis),
      construction: { status: "partial", phase: "header" },
    };
    workflowMachine.workflow.children.push(loop);
    for (const condition of conditions) {
      condition.markContainsStep();
    }
    runtime.add(
      new LoopStatementMachine({
        workflow: workflowMachine.workflow,
        loop,
        parentId: conditions.at(-1)?.id ?? parentId,
        openParentheses: context.depth.parentheses + 1,
        headerStart: openingParenthesis.end,
      }),
    );
  }

  function discoverParallel(
    method: PositionedWorkflowToken,
    strategy: ParallelStrategy,
    workflowMachine: WorkflowDefinitionMachine,
    context: TokenMachineContext,
  ): void {
    const conditions = activeConditionMachines(workflowMachine.workflow);
    const parentId = activeContainerId(workflowMachine.workflow) ?? workflowMachine.id;
    const ordinal = nextNodeOrdinal(workflowMachine.workflow);
    const parallel: ParallelNode = {
      id: `${workflowMachine.id}/parallel#${ordinal}`,
      kind: "parallel",
      label: `Promise.${strategy}`,
      strategy,
      workflowName: workflowMachine.workflow.node.name,
      order: nextChildOrder(workflowMachine.workflow, parentId),
      sourceOrder: ordinal,
      parentId,
      source: sourceRangeFromToken(path, method),
      construction: { status: "partial", phase: "discovered" },
    };
    workflowMachine.workflow.children.push(parallel);
    moveBeforeWrappingReturn(workflowMachine.workflow, parallel);
    for (const condition of conditions) {
      condition.markContainsStep();
    }
    runtime.add(
      new ParallelCallMachine({
        workflow: workflowMachine.workflow,
        parallel,
        parentId: conditions.at(-1)?.id ?? parentId,
        openParentheses: context.depth.parentheses + 1,
      }),
    );
  }

  function discoverCondition(
    openingParenthesis: PositionedWorkflowToken,
    workflowMachine: WorkflowDefinitionMachine,
    context: TokenMachineContext,
  ): void {
    const enclosingCondition = activeConditionMachines(workflowMachine.workflow).at(-1);
    const parentId = activeContainerId(workflowMachine.workflow) ?? workflowMachine.id;
    const ordinal = nextNodeOrdinal(workflowMachine.workflow);
    const condition: ConditionNode = {
      id: `${workflowMachine.id}/condition#${ordinal}`,
      kind: "condition",
      label: "if",
      condition: "",
      workflowName: workflowMachine.workflow.node.name,
      order: nextChildOrder(workflowMachine.workflow, parentId),
      sourceOrder: ordinal,
      parentId,
      source: sourceRangeFromToken(path, significantTokens.at(-1) ?? openingParenthesis),
      construction: { status: "partial", phase: "condition" },
      analysis: { status: "partial", outcomes: [], annotations: [] },
    };
    workflowMachine.workflow.children.push(condition);
    runtime.add(
      new IfStatementMachine({
        condition,
        parentId: enclosingCondition?.id ?? parentId,
        workflow: workflowMachine.workflow,
        openParentheses: context.depth.parentheses + 1,
        conditionStart: openingParenthesis.end,
      }),
    );
  }

  function discoverStep(
    openingParenthesis: PositionedWorkflowToken,
    object: PositionedWorkflowToken,
    stepType: StepType,
    workflowMachine: WorkflowDefinitionMachine,
    context: TokenMachineContext,
  ): void {
    const conditions = activeConditionMachines(workflowMachine.workflow);
    const parentId = activeContainerId(workflowMachine.workflow) ?? workflowMachine.id;
    const step = createStepNode({
      workflow: workflowMachine.workflow,
      stepType,
      label: `${stepType} step`,
      parentId,
      source: sourceRangeFromToken(path, object),
      meta: {},
      phase: "discovered",
    });
    moveBeforeWrappingReturn(workflowMachine.workflow, step);
    for (const condition of conditions) {
      condition.markContainsStep();
    }

    runtime.add(
      new StepCallMachine({
        step,
        parentId: conditions.at(-1)?.id ?? parentId,
        openParentheses: context.depth.parentheses + 1,
        baseBraces: context.depth.braces,
        baseBrackets: context.depth.brackets,
        argumentStart: openingParenthesis.end,
      }),
    );
  }

  function createStepNode({
    workflow,
    stepType,
    label,
    parentId,
    source,
    meta,
    phase,
  }: {
    workflow: WorkflowBuilder;
    stepType: StepType;
    label: string;
    parentId: string;
    source: SourceRange;
    meta: StepMeta;
    phase: StepNode["construction"]["phase"];
  }): StepNode {
    const ordinal = nextNodeOrdinal(workflow);
    const step: StepNode = {
      id: `${workflow.node.id}/step#${ordinal}`,
      kind: "step",
      label,
      stepType,
      workflowName: workflow.node.name,
      order: nextChildOrder(workflow, parentId),
      sourceOrder: ordinal,
      parentId,
      source,
      meta,
      construction: { status: "partial", phase },
    };
    workflow.children.push(step);
    return step;
  }

  function createTerminalNode({
    workflow,
    terminalType,
    label,
    parentId,
    source,
    phase,
  }: {
    workflow: WorkflowBuilder;
    terminalType: TerminalType;
    label: string;
    parentId: string;
    source: SourceRange;
    phase: TerminalNode["construction"]["phase"];
  }): TerminalNode {
    const ordinal = nextNodeOrdinal(workflow);
    const terminal: TerminalNode = {
      id: `${workflow.node.id}/terminal#${ordinal}`,
      kind: "terminal",
      label,
      terminalType,
      value: "",
      workflowName: workflow.node.name,
      order: nextChildOrder(workflow, parentId),
      sourceOrder: ordinal,
      parentId,
      source,
      construction: { status: "partial", phase },
    };
    workflow.children.push(terminal);
    return terminal;
  }

  function moveBeforeWrappingReturn(
    workflow: WorkflowBuilder,
    node: ParallelNode | StepNode,
  ): void {
    const returnMachine = runtime.findLast(
      (machine): machine is ReturnStatementMachine =>
        isReturnStatementMachine(machine) && workflow.children.includes(machine.terminal),
    );
    if (!returnMachine || returnMachine.terminal.parentId !== node.parentId) {
      return;
    }
    const terminalOrder = returnMachine.terminal.order;
    returnMachine.terminal.order = node.order;
    node.order = terminalOrder;
    returnMachine.markDelegatedValue();
  }

  function nextNodeOrdinal(workflow: WorkflowBuilder): number {
    const ordinal = workflow.nextNodeOrdinal;
    workflow.nextNodeOrdinal += 1;
    return ordinal;
  }

  function nextChildOrder(workflow: WorkflowBuilder, parentId: string): number {
    return workflow.children.filter((node) => node.parentId === parentId).length;
  }

  function activeWorkflowMachine(
    context: TokenMachineContext,
  ): WorkflowDefinitionMachine | undefined {
    return runtime.findLast(
      (machine): machine is WorkflowDefinitionMachine =>
        isWorkflowDefinitionMachine(machine) && machine.isBodyActive(context),
    );
  }

  function activeLoopMachines(workflow: WorkflowBuilder): LoopStatementMachine[] {
    return runtime.all(isLoopStatementMachine).filter((loop) => loop.workflow === workflow);
  }

  function activeConditionMachines(workflow: WorkflowBuilder): IfStatementMachine[] {
    return runtime
      .all(isIfStatementMachine)
      .filter(
        (condition) =>
          condition.workflow === workflow && condition.activeBranchCondition() !== undefined,
      );
  }

  function activeContainerId(workflow: WorkflowBuilder): string | undefined {
    const container = runtime.findLast(
      (
        machine,
      ): machine is
        | StepCallMachine
        | ParallelCallMachine
        | IfStatementMachine
        | LoopStatementMachine =>
        (isStepCallMachine(machine) && workflow.children.includes(machine.step)) ||
        (isParallelCallMachine(machine) && workflow.children.includes(machine.parallel)) ||
        (isIfStatementMachine(machine) && machine.workflow === workflow) ||
        (isLoopStatementMachine(machine) && machine.workflow === workflow),
    );
    if (container && isStepCallMachine(container)) {
      return container.step.id;
    }
    if (container && isParallelCallMachine(container)) {
      return container.activeContainerId();
    }
    if (container && isIfStatementMachine(container)) {
      return container.activeContainerId();
    }
    return container && isLoopStatementMachine(container)
      ? container.activeContainerId()
      : undefined;
  }

  function updateDelimiterDepth(value: string): void {
    switch (value) {
      case "(":
        parentheses += 1;
        break;
      case ")":
        parentheses = Math.max(0, parentheses - 1);
        break;
      case "{":
        braces += 1;
        break;
      case "}":
        braces = Math.max(0, braces - 1);
        break;
      case "[":
        brackets += 1;
        break;
      case "]":
        brackets = Math.max(0, brackets - 1);
        break;
    }
  }

  function machineContext(): TokenMachineContext {
    return {
      source,
      depth: { parentheses, braces, brackets },
    };
  }

  function commit(): WorkflowMachineUpdate {
    const graph = materializeGraph();
    const patches = diffGraph(currentGraph, graph);
    currentGraph = graph;
    for (const patch of patches) {
      for (const listener of listeners) {
        listener(patch);
      }
    }
    return { graph: cloneGraph(graph), state: machineState(), patches };
  }

  function materializeGraph(): WorkflowGraph {
    const projectedWorkflows = workflows.map((workflow) => {
      const children = projectWorkflowChildren(workflow.children);
      analyzeWorkflowConditions({ workflow: workflow.node, children, tokens: significantTokens });
      return { workflow, children };
    });
    const nodes = projectedWorkflows.flatMap(({ workflow, children }) => [
      cloneNode(workflow.node),
      ...children.map(cloneNode),
    ]);
    const edges: GraphEdge[] = [];
    for (const { children } of projectedWorkflows) {
      const childrenByParent = new Map<string, WorkflowChildNode[]>();
      const alternativeParentIds = new Set(
        children
          .filter(
            (node) =>
              node.kind === "parallel" ||
              (node.kind === "condition" &&
                children.some((child) => child.kind === "branch" && child.parentId === node.id)),
          )
          .map((node) => node.id),
      );

      for (const node of children) {
        const siblings = childrenByParent.get(node.parentId) ?? [];
        siblings.push(node);
        childrenByParent.set(node.parentId, siblings);
        edges.push({
          id: `contains:${node.parentId}->${node.id}`,
          from: node.parentId,
          to: node.id,
          type: "contains",
        });
      }
      for (const [parentId, siblings] of childrenByParent) {
        siblings.sort((left, right) => left.order - right.order);
        if (alternativeParentIds.has(parentId)) {
          continue;
        }
        for (let index = 1; index < siblings.length; index += 1) {
          const previous = siblings[index - 1];
          const next = siblings[index];
          edges.push({
            id: `sequence:${previous.id}->${next.id}`,
            from: previous.id,
            to: next.id,
            type: "sequence",
          });
        }
      }
    }

    return {
      version: 2,
      nodes,
      edges,
      diagnostics: materializeDiagnostics(),
    };
  }

  function projectWorkflowChildren(children: WorkflowChildNode[]): WorkflowChildNode[] {
    const sortedChildren = children.toSorted((left, right) => left.sourceOrder - right.sourceOrder);
    const omittedBranches = new Map<string, string>();
    for (const branch of sortedChildren) {
      if (branch.kind !== "branch" || branch.branchType !== "then") {
        continue;
      }
      const hasElse = sortedChildren.some(
        (candidate) =>
          candidate.kind === "branch" &&
          candidate.parentId === branch.parentId &&
          candidate.branchType === "else",
      );
      if (!hasElse) {
        omittedBranches.set(branch.id, branch.parentId);
      }
    }

    return sortedChildren.flatMap((node) => {
      if (omittedBranches.has(node.id)) {
        return [];
      }
      const projected = cloneNode(node);
      const flattenedParentId = omittedBranches.get(projected.parentId);
      if (flattenedParentId) {
        projected.parentId = flattenedParentId;
      }
      return [projected];
    });
  }

  function materializeDiagnostics(): Diagnostic[] {
    const diagnostics = lexicalDiagnostics.map(cloneDiagnostic);
    if (!finished) {
      return diagnostics;
    }

    if (openToken) {
      diagnostics.push({
        severity: "info",
        code: "open-token",
        message: `${openToken.type} is not closed yet.`,
        source: sourceRangeAtOffset(path, source, openToken.start),
      });
    }
    for (const workflow of workflows) {
      if (!workflow.hasSourceName) {
        diagnostics.push({
          severity: "warning",
          code: "missing-workflow-name",
          message: `Using path-derived workflow name ${JSON.stringify(workflow.node.name)}.`,
          source: cloneSourceRange(workflow.node.source),
        });
      }
    }
    for (const machine of runtime.all(isWorkflowDefinitionMachine)) {
      diagnostics.push({
        severity: "info",
        code: "incomplete-workflow",
        message: `Workflow ${JSON.stringify(machine.workflow.node.name)} is still being constructed.`,
        source: cloneSourceRange(machine.workflow.node.source),
      });
    }
    for (const machine of runtime.all(isLoopStatementMachine)) {
      diagnostics.push({
        severity: "info",
        code: "incomplete-loop",
        message: `${machine.loop.label} is still being constructed.`,
        source: cloneSourceRange(machine.loop.source),
      });
    }
    for (const machine of runtime.all(isParallelCallMachine)) {
      diagnostics.push({
        severity: "info",
        code: "incomplete-parallel",
        message: `${machine.parallel.label} is still being constructed.`,
        source: cloneSourceRange(machine.parallel.source),
      });
    }
    for (const machine of runtime.all(isStepCallMachine)) {
      const step = workflows
        .flatMap((workflow) => workflow.children)
        .find((node): node is StepNode => node.kind === "step" && node.id === machine.id);
      if (step) {
        diagnostics.push({
          severity: "info",
          code: "incomplete-step",
          message: `Step ${JSON.stringify(step.label)} is still being constructed.`,
          source: cloneSourceRange(step.source),
        });
      }
    }
    for (const machine of runtime.all(isReturnStatementMachine)) {
      diagnostics.push({
        severity: "info",
        code: "incomplete-return",
        message: `${machine.terminal.terminalType === "early-return" ? "Early return" : "Final return"} is still being constructed.`,
        source: cloneSourceRange(machine.terminal.source),
      });
    }
    for (const machine of runtime.all(isThrowStatementMachine)) {
      diagnostics.push({
        severity: "info",
        code: "incomplete-throw",
        message: `Error terminal ${JSON.stringify(machine.terminal.label)} has an incomplete expression.`,
        source: cloneSourceRange(machine.terminal.source),
      });
    }
    return diagnostics;
  }

  function machineState(): WorkflowMachineState {
    return {
      status: finished ? "finished" : tokenCount === 0 ? "empty" : "tokenizing",
      tokenCount,
      sourceLength: source.length,
      delimiterDepth: { parentheses, braces, brackets },
      activeConstructs: runtime.activeConstructs(),
      ...(openToken ? { openToken: { ...openToken } } : {}),
    };
  }

  return {
    push,
    pushAll,
    finish,
    snapshot,
    source: () => source,
    onPatch(listener) {
      listeners.add(listener);
      listener({ type: "reset", graph: cloneGraph(currentGraph) });
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function directWorkflowDefinitionKind(
  significantTokens: PositionedWorkflowToken[],
): "local" | "remote" | undefined {
  let calleeIndex = significantTokens.length - 1;
  if (/^>+$/u.test(significantTokens[calleeIndex]?.token.value ?? "")) {
    calleeIndex = tokenBeforeTypeArguments(significantTokens, calleeIndex);
  }

  const callee = significantTokens[calleeIndex]?.token.value;
  if (callee !== "defineWorkflow" && callee !== "defineRemoteWorkflow") {
    return undefined;
  }

  const prefix = significantTokens[calleeIndex - 1]?.token.value;
  const isMemberCall = prefix === "." || prefix === "?.";
  const isDeclaration =
    prefix === "function" ||
    (prefix === "*" && significantTokens[calleeIndex - 2]?.token.value === "function");
  const isConstructor = prefix === "new";
  if (isMemberCall || isDeclaration || isConstructor) {
    return undefined;
  }

  return callee === "defineRemoteWorkflow" ? "remote" : "local";
}

function directLoopType(significantTokens: PositionedWorkflowToken[]): LoopType | undefined {
  const previous = significantTokens.at(-1)?.token.value;
  if (previous === "for" || previous === "while") {
    return previous;
  }
  return previous === "await" && significantTokens.at(-2)?.token.value === "for"
    ? "for"
    : undefined;
}

function directPromiseCombinator(
  significantTokens: PositionedWorkflowToken[],
): { strategy: ParallelStrategy; object: PositionedWorkflowToken } | undefined {
  const methodToken = significantTokens.at(-1);
  const dot = significantTokens.at(-2);
  const object = significantTokens.at(-3);
  const strategy = methodToken?.token.value as ParallelStrategy | undefined;
  if (
    dot?.token.value !== "." ||
    object?.token.type !== "IdentifierName" ||
    object.token.value !== "Promise" ||
    strategy === undefined ||
    (strategy !== "all" && strategy !== "race" && strategy !== "any")
  ) {
    return undefined;
  }
  return { strategy, object };
}

function directStepCall(
  significantTokens: PositionedWorkflowToken[],
  stepParameter: string,
): { object: PositionedWorkflowToken; method: StepType } | undefined {
  let methodIndex = significantTokens.length - 1;
  if (/^>+$/u.test(significantTokens[methodIndex]?.token.value ?? "")) {
    methodIndex = tokenBeforeTypeArguments(significantTokens, methodIndex);
  }

  const methodToken = significantTokens[methodIndex];
  const dot = significantTokens[methodIndex - 1];
  const object = significantTokens[methodIndex - 2];
  const method = methodToken?.token.value as StepType | undefined;
  if (
    dot?.token.value !== "." ||
    object?.token.type !== "IdentifierName" ||
    object.token.value !== stepParameter ||
    method === undefined ||
    !STEP_METHODS.has(method)
  ) {
    return undefined;
  }

  return { object, method };
}

function tokenBeforeTypeArguments(
  significantTokens: PositionedWorkflowToken[],
  closingIndex: number,
): number {
  let angleDepth = 0;
  for (let index = closingIndex; index >= 0; index -= 1) {
    const value = significantTokens[index]?.token.value ?? "";
    if (/^>+$/u.test(value)) {
      angleDepth += value.length;
      continue;
    }
    if (!/^<+$/u.test(value)) {
      continue;
    }

    angleDepth -= value.length;
    if (angleDepth === 0) {
      return index - 1;
    }
    if (angleDepth < 0) {
      return -1;
    }
  }
  return -1;
}

function workflowNameFromPath(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.split(".")[0] || "workflow";
}

function positionAfterText(
  startLine: number,
  startColumn: number,
  value: string,
): { line: number; column: number } {
  const segments = value.split(/\r\n|[\n\r\u2028\u2029]/u);
  return segments.length === 1
    ? { line: startLine, column: startColumn + value.length }
    : { line: startLine + segments.length - 1, column: segments.at(-1)?.length ?? 0 };
}

function emptyGraph(): WorkflowGraph {
  return { version: 2, nodes: [], edges: [], diagnostics: [] };
}

function cloneNode<T extends WorkflowNode | WorkflowChildNode>(node: T): T {
  if (node.kind === "step") {
    return {
      ...node,
      source: cloneSourceRange(node.source),
      meta: { ...node.meta },
      construction: { ...node.construction },
    } as T;
  }
  if (node.kind === "condition") {
    return {
      ...node,
      source: cloneSourceRange(node.source),
      construction: { ...node.construction },
      analysis: cloneConditionAnalysis(node.analysis),
    } as T;
  }
  return {
    ...node,
    source: cloneSourceRange(node.source),
    construction: { ...node.construction },
  } as T;
}

function cloneConditionAnalysis(analysis: ConditionAnalysis): ConditionAnalysis {
  if (analysis.status !== "complete") {
    return { status: analysis.status, outcomes: [], annotations: [] };
  }
  return {
    status: "complete",
    predicate: clonePredicate(analysis.predicate),
    outcomes: analysis.outcomes.map((outcome) => ({
      path: outcome.path,
      predicate: clonePredicate(outcome.predicate),
      completion: { ...outcome.completion },
    })),
    annotations: analysis.annotations.map((annotation) => ({
      ...annotation,
      subject: { ...annotation.subject, path: [...annotation.subject.path] },
    })),
  };
}

function clonePredicate(predicate: SemanticPredicate): SemanticPredicate {
  if (predicate.kind === "comparison") {
    return {
      ...predicate,
      left:
        predicate.left.kind === "reference"
          ? { ...predicate.left, path: [...predicate.left.path] }
          : { ...predicate.left },
      right:
        predicate.right.kind === "reference"
          ? { ...predicate.right, path: [...predicate.right.path] }
          : { ...predicate.right },
    };
  }
  if (predicate.kind === "not") {
    return { kind: "not", predicate: clonePredicate(predicate.predicate) };
  }
  return { kind: predicate.kind, predicates: predicate.predicates.map(clonePredicate) };
}

function cloneDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return { ...diagnostic, source: cloneSourceRange(diagnostic.source) };
}

function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    version: 2,
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map((edge) => ({ ...edge })),
    diagnostics: graph.diagnostics.map(cloneDiagnostic),
  };
}

export function diffGraph(previous: WorkflowGraph, next: WorkflowGraph): GraphPatch[] {
  const patches: GraphPatch[] = [];
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  for (const [id, node] of nextNodes) {
    const before = previousNodes.get(id);
    if (!before || !jsonEqual(before, node)) {
      patches.push({ type: "node.upsert", node });
    }
  }
  for (const id of previousNodes.keys()) {
    if (!nextNodes.has(id)) {
      patches.push({ type: "node.remove", id });
    }
  }

  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  for (const [id, edge] of nextEdges) {
    const before = previousEdges.get(id);
    if (!before || !jsonEqual(before, edge)) {
      patches.push({ type: "edge.upsert", edge });
    }
  }
  for (const id of previousEdges.keys()) {
    if (!nextEdges.has(id)) {
      patches.push({ type: "edge.remove", id });
    }
  }

  if (!jsonEqual(previous.diagnostics, next.diagnostics)) {
    patches.push({ type: "diagnostics.set", diagnostics: next.diagnostics });
  }
  return patches;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
