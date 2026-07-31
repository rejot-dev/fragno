import { conciseFunctionEndsBefore } from "./function-scope.ts";
import type {
  BranchNode,
  ConditionNode,
  LoopNode,
  ParallelNode,
  SourceRange,
  StepNode,
  StepReturn,
  TerminalNode,
  WorkflowChildNode,
  WorkflowNode,
} from "./model.ts";
import {
  endSourceRangeAtTokenStart,
  extendSourceRangeToRange,
  extendSourceRangeToToken,
  sourceRangeFromToken,
} from "./source-location.ts";
import type {
  PositionedWorkflowToken,
  TokenMachineContext,
  TokenSubmachine,
  TokenSubmachineStatus,
} from "./state-machine.ts";
import {
  isTriviaToken,
  staticStringValue,
  tokenizeWorkflowSource,
  tokenIsOpen,
  type WorkflowToken,
} from "./tokenizer.ts";

export interface WorkflowBuilder {
  node: WorkflowNode;
  hasSourceName: boolean;
  nextNodeOrdinal: number;
  children: WorkflowChildNode[];
}

export class WorkflowDefinitionMachine implements TokenSubmachine {
  readonly kind = "workflow" as const;
  readonly parentId: string | undefined;
  readonly #workflow: WorkflowBuilder;
  readonly #openParentheses: number;
  readonly #baseBraces: number;
  readonly #baseBrackets: number;
  #argumentIndex = 0;
  #argumentStart: number;
  #optionNameState: "name" | "value" | undefined;
  #stepParameter = "step";
  #sawCallback = false;
  #bodyBraces: number | undefined;
  #bodyClosed = false;

  constructor({
    workflow,
    parentId,
    openParentheses,
    baseBraces,
    baseBrackets,
    argumentStart,
  }: {
    workflow: WorkflowBuilder;
    parentId?: string;
    openParentheses: number;
    baseBraces: number;
    baseBrackets: number;
    argumentStart: number;
  }) {
    this.#workflow = workflow;
    this.parentId = parentId;
    this.#openParentheses = openParentheses;
    this.#baseBraces = baseBraces;
    this.#baseBrackets = baseBrackets;
    this.#argumentStart = argumentStart;
  }

  get id(): string {
    return this.#workflow.node.id;
  }

  get phase(): string {
    return this.#workflow.node.construction.phase;
  }

  get source() {
    return this.#workflow.node.source;
  }

  get workflow(): WorkflowBuilder {
    return this.#workflow;
  }

  get stepParameter(): string {
    return this.#stepParameter;
  }

  isBodyActive(context: TokenMachineContext): boolean {
    return (
      this.#bodyBraces !== undefined &&
      !this.#bodyClosed &&
      context.depth.braces >= this.#bodyBraces
    );
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    extendSourceRangeToToken(this.#workflow.node.source, positioned);
    const { token } = positioned;
    const { depth } = context;
    const directArgumentToken =
      depth.parentheses === this.#openParentheses &&
      depth.braces === this.#baseBraces &&
      depth.brackets === this.#baseBrackets;

    if (token.value === "," && directArgumentToken) {
      this.#argumentIndex += 1;
      this.#argumentStart = positioned.end;
      this.#optionNameState = undefined;
      return "active";
    }

    if (this.#argumentIndex === 0 && depth.braces === this.#baseBraces + 1) {
      this.consumeWorkflowName(token);
    }

    if (token.value === "=>" && this.#argumentIndex >= 1 && !this.#sawCallback) {
      this.#stepParameter =
        secondArrowParameter(context.source.slice(this.#argumentStart, positioned.start)) ??
        this.#stepParameter;
      this.#sawCallback = true;
      return "active";
    }

    if (token.value === "{" && this.#argumentIndex >= 1 && this.#bodyBraces === undefined) {
      if (!this.#sawCallback) {
        const functionExpression = functionExpressionCallback(
          context.source.slice(this.#argumentStart, positioned.start),
        );
        if (!functionExpression) {
          return "active";
        }
        this.#stepParameter = functionExpression.stepParameter ?? this.#stepParameter;
        this.#sawCallback = true;
      }

      this.#bodyBraces = depth.braces + 1;
      this.#workflow.node.construction = { status: "partial", phase: "body" };
      return "active";
    }

    if (token.value === "}" && this.#bodyBraces === depth.braces) {
      this.#bodyClosed = true;
      return "active";
    }

    if (token.value === ")" && depth.parentheses === this.#openParentheses) {
      this.#workflow.node.construction = { status: "complete", phase: "complete" };
      return "complete";
    }

    return "active";
  }

  private consumeWorkflowName(token: PositionedWorkflowToken["token"]): void {
    if (token.type === "IdentifierName" && token.value === "name") {
      this.#optionNameState = "name";
      return;
    }
    if (token.value === ":" && this.#optionNameState === "name") {
      this.#optionNameState = "value";
      return;
    }
    if (this.#optionNameState !== "value") {
      return;
    }

    const name = staticStringValue(token);
    if (name) {
      this.#workflow.hasSourceName = true;
      this.#workflow.node.name = name;
      this.#workflow.node.label = name;
      if (this.#workflow.node.construction.phase !== "body") {
        this.#workflow.node.construction = {
          status: "partial",
          phase: tokenIsOpen(token) ? "naming" : "configured",
        };
      }
      for (const child of this.#workflow.children) {
        child.workflowName = name;
      }
    }
    this.#optionNameState = undefined;
  }
}

export class LoopStatementMachine implements TokenSubmachine {
  readonly kind = "loop" as const;
  readonly parentId: string;
  readonly #workflow: WorkflowBuilder;
  readonly #loop: LoopNode;
  readonly #openParentheses: number;
  readonly #headerStart: number;
  #phase: "header" | "body-pending" | "body" | "statement" = "header";
  #bodyBraces: number | undefined;
  #statementDepth: TokenMachineContext["depth"] | undefined;

  constructor({
    workflow,
    loop,
    parentId,
    openParentheses,
    headerStart,
  }: {
    workflow: WorkflowBuilder;
    loop: LoopNode;
    parentId: string;
    openParentheses: number;
    headerStart: number;
  }) {
    this.#workflow = workflow;
    this.#loop = loop;
    this.parentId = parentId;
    this.#openParentheses = openParentheses;
    this.#headerStart = headerStart;
  }

  get id(): string {
    return this.#loop.id;
  }

  get phase(): string {
    return this.#loop.construction.phase;
  }

  get source() {
    return this.#loop.source;
  }

  get workflow(): WorkflowBuilder {
    return this.#workflow;
  }

  get loop(): LoopNode {
    return this.#loop;
  }

  activeContainerId(): string {
    return this.#loop.id;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    extendSourceRangeToToken(this.#loop.source, positioned);
    const value = positioned.token.value;
    if (this.#phase === "header") {
      if (value === ")" && context.depth.parentheses === this.#openParentheses) {
        this.updateExpression(context.source, positioned.start);
        this.#loop.construction = { status: "partial", phase: "body" };
        this.#phase = "body-pending";
        return "active";
      }
      this.updateExpression(context.source, positioned.end);
      return "active";
    }

    if (this.#phase === "body-pending") {
      if (value === "{") {
        this.#bodyBraces = context.depth.braces + 1;
        this.#phase = "body";
        return "active";
      }
      this.#statementDepth = { ...context.depth };
      this.#phase = "statement";
      if (value === ";") {
        this.complete();
        return "complete";
      }
      return "active";
    }

    if (this.#phase === "body" && value === "}" && context.depth.braces === this.#bodyBraces) {
      this.complete();
      return "complete";
    }

    if (
      this.#phase === "statement" &&
      value === ";" &&
      this.#statementDepth !== undefined &&
      sameDepth(context.depth, this.#statementDepth)
    ) {
      this.complete();
      return "complete";
    }

    return "active";
  }

  private updateExpression(source: string, end: number): void {
    this.#loop.expression = source.slice(this.#headerStart, end).trim();
    this.#loop.label = this.#loop.expression
      ? `${this.#loop.loopType} ${this.#loop.expression}`
      : this.#loop.loopType;
  }

  private complete(): void {
    this.#loop.construction = { status: "complete", phase: "complete" };
  }
}

export class ParallelCallMachine implements TokenSubmachine {
  readonly kind = "parallel" as const;
  readonly parentId: string;
  readonly #workflow: WorkflowBuilder;
  readonly #parallel: ParallelNode;
  readonly #openParentheses: number;
  #arrayBrackets: number | undefined;
  #activeBranch: BranchNode | undefined;
  #nextBranchIndex = 0;

  constructor({
    workflow,
    parallel,
    parentId,
    openParentheses,
  }: {
    workflow: WorkflowBuilder;
    parallel: ParallelNode;
    parentId: string;
    openParentheses: number;
  }) {
    this.#workflow = workflow;
    this.#parallel = parallel;
    this.parentId = parentId;
    this.#openParentheses = openParentheses;
  }

  get id(): string {
    return this.#parallel.id;
  }

  get phase(): string {
    return this.#parallel.construction.phase;
  }

  get source() {
    return this.#parallel.source;
  }

  get parallel(): ParallelNode {
    return this.#parallel;
  }

  activeContainerId(): string {
    return this.#activeBranch?.id ?? this.#parallel.id;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    extendSourceRangeToToken(this.#parallel.source, positioned);
    if (this.#activeBranch) {
      extendSourceRangeToToken(this.#activeBranch.source, positioned);
    }
    const value = positioned.token.value;
    if (
      value === "[" &&
      context.depth.parentheses === this.#openParentheses &&
      this.#arrayBrackets === undefined
    ) {
      this.#arrayBrackets = context.depth.brackets + 1;
      this.#parallel.construction = { status: "partial", phase: "branches" };
      return "active";
    }

    if (
      this.#arrayBrackets !== undefined &&
      context.depth.parentheses === this.#openParentheses &&
      context.depth.brackets === this.#arrayBrackets
    ) {
      if (value === ",") {
        this.completeActiveBranch();
        return "active";
      }
      if (value === "]") {
        this.completeActiveBranch();
        this.#arrayBrackets = undefined;
        return "active";
      }
      this.#activeBranch ??= this.createBranch(positioned);
    }

    if (value === ")" && context.depth.parentheses === this.#openParentheses) {
      this.completeActiveBranch();
      this.#parallel.construction = { status: "complete", phase: "complete" };
      return "complete";
    }

    return "active";
  }

  private createBranch(positioned: PositionedWorkflowToken): BranchNode {
    const index = this.#nextBranchIndex;
    this.#nextBranchIndex += 1;
    const sourceOrder = this.#workflow.nextNodeOrdinal;
    this.#workflow.nextNodeOrdinal += 1;
    const branch: BranchNode = {
      id: `${this.#parallel.id}/branch#${index}`,
      kind: "branch",
      label: `branch ${index + 1}`,
      branchType: "parallel",
      index,
      workflowName: this.#workflow.node.name,
      order: index,
      sourceOrder,
      parentId: this.#parallel.id,
      source: sourceRangeFromToken(this.#parallel.source.path, positioned),
      construction: { status: "partial", phase: "body" },
    };
    this.#workflow.children.push(branch);
    return branch;
  }

  private completeActiveBranch(): void {
    if (this.#activeBranch) {
      this.#activeBranch.construction = { status: "complete", phase: "complete" };
      this.#activeBranch = undefined;
    }
  }
}

export class StepCallMachine implements TokenSubmachine {
  readonly kind = "step" as const;
  readonly parentId: string;
  readonly #step: StepNode;
  readonly #openParentheses: number;
  readonly #baseBraces: number;
  readonly #baseBrackets: number;
  #argumentIndex = 0;
  #argumentStart: number;
  #argumentTokens: PositionedWorkflowToken[] = [];
  #optionProperty: { name: "type" | "timeout"; awaitingValue: boolean } | undefined;

  constructor({
    step,
    parentId,
    openParentheses,
    baseBraces,
    baseBrackets,
    argumentStart,
  }: {
    step: StepNode;
    parentId: string;
    openParentheses: number;
    baseBraces: number;
    baseBrackets: number;
    argumentStart: number;
  }) {
    this.#step = step;
    this.parentId = parentId;
    this.#openParentheses = openParentheses;
    this.#baseBraces = baseBraces;
    this.#baseBrackets = baseBrackets;
    this.#argumentStart = argumentStart;
  }

  get id(): string {
    return this.#step.id;
  }

  get phase(): string {
    return this.#step.construction.phase;
  }

  get source() {
    return this.#step.source;
  }

  get step(): StepNode {
    return this.#step;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    extendSourceRangeToToken(this.#step.source, positioned);
    const { token } = positioned;
    const { depth } = context;
    const directArgumentToken =
      depth.parentheses === this.#openParentheses &&
      depth.braces === this.#baseBraces &&
      depth.brackets === this.#baseBrackets;

    if (token.value === ")" && depth.parentheses === this.#openParentheses) {
      this.updateRawArgument(context.source, positioned.start);
      this.#step.analysis = {
        status: "complete",
        invocations: this.#step.analysis.invocations,
        returns: this.#step.analysis.returns,
      };
      this.#step.construction = { status: "complete", phase: "complete" };
      return "complete";
    }

    if (token.value === "," && directArgumentToken) {
      this.updateRawArgument(context.source, positioned.start);
      this.#argumentIndex += 1;
      this.#argumentStart = positioned.end;
      this.#argumentTokens = [];
      this.#optionProperty = undefined;
      return "active";
    }

    this.#argumentTokens.push(positioned);
    if (this.#argumentIndex === 0) {
      this.updateStepLabel();
    }

    if (this.#argumentIndex === 1) {
      this.consumeStepMeta(token);
      this.updateRawArgument(context.source, positioned.end);
    }

    return "active";
  }

  private updateStepLabel(): void {
    const label = staticArgumentValue(this.#argumentTokens);
    if (label === undefined) {
      this.#step.label = `${this.#step.stepType} step`;
      this.#step.construction = { status: "partial", phase: "discovered" };
      return;
    }

    this.#step.label = label || `${this.#step.stepType} step`;
    this.#step.construction = { status: "partial", phase: "labeled" };
  }

  private updateRawArgument(source: string, end: number): void {
    if (this.#argumentIndex !== 1 || this.#step.stepType !== "sleepUntil") {
      return;
    }
    const until = source.slice(this.#argumentStart, end).trim();
    if (until) {
      this.#step.meta.until = until;
    }
  }

  private consumeStepMeta(token: PositionedWorkflowToken["token"]): void {
    if (this.#step.stepType === "sleep") {
      const duration = staticArgumentValue(this.#argumentTokens);
      if (duration === undefined) {
        delete this.#step.meta.duration;
      } else {
        this.#step.meta.duration = duration;
      }
      return;
    }

    if (this.#step.stepType !== "waitForEvent") {
      return;
    }

    if (token.type === "IdentifierName" && (token.value === "type" || token.value === "timeout")) {
      this.#optionProperty = { name: token.value, awaitingValue: false };
      return;
    }
    if (token.value === ":" && this.#optionProperty) {
      this.#optionProperty.awaitingValue = true;
      return;
    }
    if (!this.#optionProperty?.awaitingValue) {
      return;
    }

    const optionValue = staticStringValue(token);
    if (optionValue !== undefined) {
      if (this.#optionProperty.name === "type") {
        this.#step.meta.eventType = optionValue;
      } else {
        this.#step.meta.timeout = optionValue;
      }
    }
    this.#optionProperty = undefined;
  }
}

type IfPhase =
  | "condition"
  | "consequent-pending"
  | "consequent"
  | "consequent-statement"
  | "waiting-else"
  | "alternate-pending"
  | "alternate"
  | "alternate-statement";

type IfBranch = "consequent" | "alternate";

interface BranchProgress {
  node?: BranchNode;
  bodyBraces?: number;
  statementDepth?: TokenMachineContext["depth"];
  firstStatementToken?: string;
  lastToken?: PositionedWorkflowToken;
  containsStep: boolean;
  abruptCompletionId?: string;
}

class ReturnExpressionScanner {
  readonly #source: SourceRange;
  readonly #statement: PositionedWorkflowToken;
  readonly #expressionStart: number;
  readonly #baseDepth: TokenMachineContext["depth"];
  readonly #onValue: (value: string, token?: PositionedWorkflowToken["token"]) => void;
  readonly #onComplete: () => void;
  #lastToken: PositionedWorkflowToken | undefined;

  constructor({
    source,
    statement,
    baseDepth,
    onValue,
    onComplete,
  }: {
    source: SourceRange;
    statement: PositionedWorkflowToken;
    baseDepth: TokenMachineContext["depth"];
    onValue: (value: string, token?: PositionedWorkflowToken["token"]) => void;
    onComplete: () => void;
  }) {
    this.#source = source;
    this.#statement = statement;
    this.#expressionStart = statement.end;
    this.#baseDepth = { ...baseDepth };
    this.#onValue = onValue;
    this.#onComplete = onComplete;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    const value = positioned.token.value;
    if ((value === ";" || value === "}") && sameDepth(context.depth, this.#baseDepth)) {
      if (value === ";") {
        extendSourceRangeToToken(this.#source, positioned);
      } else {
        endSourceRangeAtTokenStart(this.#source, positioned);
      }
      this.complete(context.source, positioned.start);
      return "complete";
    }
    if (
      this.#lastToken === undefined &&
      hasLineTerminatorBetween(this.#statement, positioned, context.source)
    ) {
      this.complete(context.source, this.#expressionStart);
      return "complete";
    }
    if (
      this.#lastToken &&
      sameDepth(context.depth, this.#baseDepth) &&
      hasLineTerminatorBetween(this.#lastToken, positioned, context.source) &&
      tokenCanEndStatement(this.#lastToken.token) &&
      !tokenContinuesStatement(positioned.token)
    ) {
      this.complete(context.source, positioned.start);
      return "complete";
    }

    this.#lastToken = positioned;
    extendSourceRangeToToken(this.#source, positioned);
    this.#onValue(
      context.source.slice(this.#expressionStart, positioned.end).trim(),
      positioned.token,
    );
    return "active";
  }

  finish(context: TokenMachineContext): TokenSubmachineStatus {
    this.#onValue(context.source.slice(this.#expressionStart).trim());
    return "active";
  }

  private complete(source: string, expressionEnd: number): void {
    this.#onValue(source.slice(this.#expressionStart, expressionEnd).trim());
    this.#onComplete();
  }
}

export class StepReturnStatementMachine implements TokenSubmachine {
  readonly kind = "return" as const;
  readonly id: string;
  readonly parentId: string;
  readonly #stepReturn: StepReturn;
  readonly #scanner: ReturnExpressionScanner;

  constructor({
    id,
    parentId,
    stepReturn,
    statement,
    baseDepth,
  }: {
    id: string;
    parentId: string;
    stepReturn: StepReturn;
    statement: PositionedWorkflowToken;
    baseDepth: TokenMachineContext["depth"];
  }) {
    this.id = id;
    this.parentId = parentId;
    this.#stepReturn = stepReturn;
    this.#scanner = new ReturnExpressionScanner({
      source: stepReturn.source,
      statement,
      baseDepth,
      onValue: (value) => {
        stepReturn.value = value;
      },
      onComplete: () => {
        stepReturn.construction = { status: "complete", phase: "complete" };
      },
    });
  }

  get phase(): string {
    return this.#stepReturn.construction.phase;
  }

  get source() {
    return this.#stepReturn.source;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    return this.#scanner.consume(positioned, context);
  }

  finish(context: TokenMachineContext): TokenSubmachineStatus {
    return this.#scanner.finish(context);
  }
}

export class StepImplicitReturnMachine implements TokenSubmachine {
  readonly kind = "return" as const;
  readonly id: string;
  readonly parentId: string;
  readonly #stepReturn: StepReturn;
  readonly #expressionStart: number;
  readonly #baseDepth: TokenMachineContext["depth"];

  constructor({
    id,
    parentId,
    stepReturn,
    expressionStart,
    baseDepth,
  }: {
    id: string;
    parentId: string;
    stepReturn: StepReturn;
    expressionStart: number;
    baseDepth: TokenMachineContext["depth"];
  }) {
    this.id = id;
    this.parentId = parentId;
    this.#stepReturn = stepReturn;
    this.#expressionStart = expressionStart;
    this.#baseDepth = { ...baseDepth };
  }

  get phase(): string {
    return this.#stepReturn.construction.phase;
  }

  get source() {
    return this.#stepReturn.source;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    if (conciseFunctionEndsBefore(positioned.token.value, context.depth, this.#baseDepth)) {
      endSourceRangeAtTokenStart(this.#stepReturn.source, positioned);
      this.#stepReturn.value = context.source.slice(this.#expressionStart, positioned.start).trim();
      this.#stepReturn.construction = { status: "complete", phase: "complete" };
      return "complete";
    }

    extendSourceRangeToToken(this.#stepReturn.source, positioned);
    this.#stepReturn.value = context.source.slice(this.#expressionStart, positioned.end).trim();
    return "active";
  }

  finish(context: TokenMachineContext): TokenSubmachineStatus {
    this.#stepReturn.value = context.source.slice(this.#expressionStart).trim();
    return "active";
  }
}

export class IfStatementMachine implements TokenSubmachine {
  readonly kind = "condition" as const;
  readonly parentId: string;
  readonly workflow: WorkflowBuilder;
  readonly #conditionNode: ConditionNode;
  readonly #openParentheses: number;
  readonly #conditionStart: number;
  readonly #consequent: BranchProgress = { containsStep: false };
  readonly #alternate: BranchProgress = { containsStep: false };
  #phase: IfPhase = "condition";

  constructor({
    condition,
    parentId,
    workflow,
    openParentheses,
    conditionStart,
  }: {
    condition: ConditionNode;
    parentId: string;
    workflow: WorkflowBuilder;
    openParentheses: number;
    conditionStart: number;
  }) {
    this.#conditionNode = condition;
    this.parentId = parentId;
    this.workflow = workflow;
    this.#openParentheses = openParentheses;
    this.#conditionStart = conditionStart;
  }

  get id(): string {
    return this.#conditionNode.id;
  }

  get phase(): string {
    return this.#phase;
  }

  get source() {
    return this.#conditionNode.source;
  }

  get condition(): ConditionNode {
    return this.#conditionNode;
  }

  activeContainerId(): string {
    return this.activeBranch()?.node?.id ?? this.#conditionNode.id;
  }

  activeBranchCondition(): string | undefined {
    if (this.#phase === "consequent" || this.#phase === "consequent-statement") {
      return this.#conditionNode.condition;
    }
    if (this.#phase === "alternate" || this.#phase === "alternate-statement") {
      return this.#conditionNode.condition ? `!(${this.#conditionNode.condition})` : "else";
    }
    return undefined;
  }

  markContainsStep(): void {
    const branch = this.activeBranch();
    if (branch) {
      branch.containsStep = true;
    }
  }

  markAbruptCompletion(nodeId: string): void {
    const branch = this.activeBranch();
    if (branch) {
      branch.abruptCompletionId = nodeId;
    }
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    const value = positioned.token.value;

    switch (this.#phase) {
      case "condition":
        extendSourceRangeToToken(this.#conditionNode.source, positioned);
        if (value === ")" && context.depth.parentheses === this.#openParentheses) {
          const condition = context.source.slice(this.#conditionStart, positioned.start).trim();
          this.#conditionNode.condition = condition;
          this.#conditionNode.label = condition ? `if ${condition.replace(/\s+/gu, " ")}` : "if";
          this.#conditionNode.construction = { status: "partial", phase: "branches" };
          this.#phase = "consequent-pending";
        }
        return "active";

      case "consequent-pending":
        extendSourceRangeToToken(this.#conditionNode.source, positioned);
        return this.startBranch("consequent", positioned, context);

      case "consequent":
        this.extendBranchSource(this.#consequent, positioned);
        this.rememberFirstStatementToken(this.#consequent, value);
        if (value === "}" && this.#consequent.bodyBraces === context.depth.braces) {
          this.completeBranch(this.#consequent);
          this.#phase = "waiting-else";
        }
        return "active";

      case "consequent-statement":
        if (statementEndsBefore(positioned, this.#consequent, context)) {
          this.completeBranch(this.#consequent);
          if (value === "else") {
            extendSourceRangeToToken(this.#conditionNode.source, positioned);
            this.#phase = "alternate-pending";
            return "active";
          }
          return this.completeCondition();
        }
        this.extendBranchSource(this.#consequent, positioned);
        this.#consequent.lastToken = positioned;
        if (isStatementTerminator(value, this.#consequent, context)) {
          this.completeBranch(this.#consequent);
          this.#phase = "waiting-else";
        }
        return "active";

      case "waiting-else":
        if (value === "else") {
          extendSourceRangeToToken(this.#conditionNode.source, positioned);
          this.#phase = "alternate-pending";
          return "active";
        }
        return this.completeCondition();

      case "alternate-pending":
        extendSourceRangeToToken(this.#conditionNode.source, positioned);
        return this.startBranch("alternate", positioned, context);

      case "alternate":
        this.extendBranchSource(this.#alternate, positioned);
        this.rememberFirstStatementToken(this.#alternate, value);
        if (value === "}" && this.#alternate.bodyBraces === context.depth.braces) {
          this.completeBranch(this.#alternate);
          return this.completeCondition();
        }
        return "active";

      case "alternate-statement":
        if (statementEndsBefore(positioned, this.#alternate, context)) {
          this.completeBranch(this.#alternate);
          return this.completeCondition();
        }
        this.extendBranchSource(this.#alternate, positioned);
        this.#alternate.lastToken = positioned;
        if (isStatementTerminator(value, this.#alternate, context)) {
          this.completeBranch(this.#alternate);
          return this.completeCondition();
        }
        return "active";
    }

    throw new Error("Unsupported if-statement phase.");
  }

  childCompleted(child: TokenSubmachine, _context: TokenMachineContext): TokenSubmachineStatus {
    if (this.#phase === "consequent-statement") {
      this.extendBranchSourceToRange(this.#consequent, child.source);
      this.completeBranch(this.#consequent);
      this.#phase = "waiting-else";
      return "active";
    }
    if (this.#phase === "alternate-statement") {
      this.extendBranchSourceToRange(this.#alternate, child.source);
      this.completeBranch(this.#alternate);
      return this.completeCondition();
    }
    return "active";
  }

  private startBranch(
    branchName: IfBranch,
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    const branch = branchName === "consequent" ? this.#consequent : this.#alternate;
    branch.node = this.createBranch(branchName, positioned);
    if (positioned.token.value === "{") {
      branch.bodyBraces = context.depth.braces + 1;
      this.#phase = branchName;
      return "active";
    }

    branch.statementDepth = { ...context.depth };
    branch.firstStatementToken = positioned.token.value;
    branch.lastToken = positioned;
    this.#phase = `${branchName}-statement`;
    return "active";
  }

  private createBranch(branchName: IfBranch, positioned: PositionedWorkflowToken): BranchNode {
    const isConsequent = branchName === "consequent";
    const sourceOrder = this.workflow.nextNodeOrdinal;
    this.workflow.nextNodeOrdinal += 1;
    const branch: BranchNode = {
      id: `${this.#conditionNode.id}/${isConsequent ? "then" : "else"}`,
      kind: "branch",
      label: isConsequent ? "then" : "else",
      branchType: isConsequent ? "then" : "else",
      index: isConsequent ? 0 : 1,
      workflowName: this.workflow.node.name,
      order: isConsequent ? 0 : 1,
      sourceOrder,
      parentId: this.#conditionNode.id,
      source: sourceRangeFromToken(this.#conditionNode.source.path, positioned),
      construction: { status: "partial", phase: "body" },
    };
    this.workflow.children.push(branch);
    return branch;
  }

  private extendBranchSource(branch: BranchProgress, positioned: PositionedWorkflowToken): void {
    extendSourceRangeToToken(this.#conditionNode.source, positioned);
    if (branch.node) {
      extendSourceRangeToToken(branch.node.source, positioned);
    }
  }

  private extendBranchSourceToRange(branch: BranchProgress, source: BranchNode["source"]): void {
    extendSourceRangeToRange(this.#conditionNode.source, source);
    if (branch.node) {
      extendSourceRangeToRange(branch.node.source, source);
    }
  }

  private completeBranch(branch: BranchProgress): void {
    if (branch.node) {
      branch.node.construction = { status: "complete", phase: "complete" };
    }
  }

  private completeCondition(): TokenSubmachineStatus {
    const hasWorkflowContent = [this.#consequent, this.#alternate].some(
      (branch) => branch.containsStep || branch.abruptCompletionId !== undefined,
    );
    if (hasWorkflowContent) {
      this.#conditionNode.construction = { status: "complete", phase: "complete" };
    } else {
      const removedIds = new Set([
        this.#conditionNode.id,
        this.#consequent.node?.id,
        this.#alternate.node?.id,
      ]);
      this.workflow.children = this.workflow.children.filter((node) => !removedIds.has(node.id));
    }
    return "complete";
  }

  private rememberFirstStatementToken(branch: BranchProgress, value: string): void {
    branch.firstStatementToken ??= value;
  }

  private activeBranch(): BranchProgress | undefined {
    if (this.#phase === "consequent" || this.#phase === "consequent-statement") {
      return this.#consequent;
    }
    if (this.#phase === "alternate" || this.#phase === "alternate-statement") {
      return this.#alternate;
    }
    return undefined;
  }
}

export class ReturnStatementMachine implements TokenSubmachine {
  readonly kind = "return" as const;
  readonly id: string;
  readonly parentId: string;
  readonly #terminal: TerminalNode;
  readonly #scanner: ReturnExpressionScanner;
  #reasonState: "reason" | "value" | undefined;
  #delegatesValueToChild = false;

  constructor({
    id,
    parentId,
    terminal,
    statement,
    baseDepth,
  }: {
    id: string;
    parentId: string;
    terminal: TerminalNode;
    statement: PositionedWorkflowToken;
    baseDepth: TokenMachineContext["depth"];
  }) {
    this.id = id;
    this.parentId = parentId;
    this.#terminal = terminal;
    this.#scanner = new ReturnExpressionScanner({
      source: terminal.source,
      statement,
      baseDepth,
      onValue: (value, token) => {
        if (this.#delegatesValueToChild) {
          return;
        }
        terminal.value = value;
        if (token) {
          this.consumeReason(token);
        }
      },
      onComplete: () => {
        terminal.construction = { status: "complete", phase: "complete" };
      },
    });
  }

  get phase(): string {
    return this.#terminal.construction.phase;
  }

  get source() {
    return this.#terminal.source;
  }

  get terminal(): TerminalNode {
    return this.#terminal;
  }

  markDelegatedValue(): void {
    this.#delegatesValueToChild = true;
    this.#terminal.value = "";
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    return this.#scanner.consume(positioned, context);
  }

  finish(context: TokenMachineContext): TokenSubmachineStatus {
    return this.#scanner.finish(context);
  }

  private consumeReason(token: PositionedWorkflowToken["token"]): void {
    if (token.type === "IdentifierName" && token.value === "reason") {
      this.#reasonState = "reason";
      return;
    }
    if (token.value === ":" && this.#reasonState === "reason") {
      this.#reasonState = "value";
      return;
    }
    if (this.#reasonState !== "value") {
      return;
    }

    const reason = staticStringValue(token);
    if (reason !== undefined && this.#terminal.terminalType === "early-return") {
      this.#terminal.label = reason || "early return";
    }
    this.#reasonState = undefined;
  }
}

export class ThrowStatementMachine implements TokenSubmachine {
  readonly kind = "throw" as const;
  readonly id: string;
  readonly parentId: string;
  readonly #terminal: TerminalNode;
  readonly #expressionStart: number;
  readonly #baseDepth: TokenMachineContext["depth"];

  constructor({
    id,
    parentId,
    terminal,
    expressionStart,
    baseDepth,
  }: {
    id: string;
    parentId: string;
    terminal: TerminalNode;
    expressionStart: number;
    baseDepth: TokenMachineContext["depth"];
  }) {
    this.id = id;
    this.parentId = parentId;
    this.#terminal = terminal;
    this.#expressionStart = expressionStart;
    this.#baseDepth = { ...baseDepth };
  }

  get phase(): string {
    return this.#terminal.construction.phase;
  }

  get source() {
    return this.#terminal.source;
  }

  get terminal(): TerminalNode {
    return this.#terminal;
  }

  consume(
    positioned: PositionedWorkflowToken,
    context: TokenMachineContext,
  ): TokenSubmachineStatus {
    const value = positioned.token.value;
    if ((value === ";" || value === "}") && sameDepth(context.depth, this.#baseDepth)) {
      if (value === ";") {
        extendSourceRangeToToken(this.#terminal.source, positioned);
      } else {
        endSourceRangeAtTokenStart(this.#terminal.source, positioned);
      }
      this.complete(context.source, positioned.start);
      return "complete";
    }

    extendSourceRangeToToken(this.#terminal.source, positioned);
    this.#terminal.value = context.source.slice(this.#expressionStart, positioned.end).trim();
    const message = staticStringValue(positioned.token);
    if (message !== undefined) {
      this.#terminal.label = message || "error";
    }
    return "active";
  }

  finish(context: TokenMachineContext): TokenSubmachineStatus {
    this.#terminal.value = context.source.slice(this.#expressionStart).trim();
    return "active";
  }

  private complete(source: string, expressionEnd: number): void {
    this.#terminal.value = source.slice(this.#expressionStart, expressionEnd).trim();
    this.#terminal.construction = { status: "complete", phase: "complete" };
  }
}

export function isWorkflowDefinitionMachine(
  machine: TokenSubmachine,
): machine is WorkflowDefinitionMachine {
  return machine instanceof WorkflowDefinitionMachine;
}

export function isLoopStatementMachine(machine: TokenSubmachine): machine is LoopStatementMachine {
  return machine instanceof LoopStatementMachine;
}

export function isParallelCallMachine(machine: TokenSubmachine): machine is ParallelCallMachine {
  return machine instanceof ParallelCallMachine;
}

export function isStepCallMachine(machine: TokenSubmachine): machine is StepCallMachine {
  return machine instanceof StepCallMachine;
}

export function isIfStatementMachine(machine: TokenSubmachine): machine is IfStatementMachine {
  return machine instanceof IfStatementMachine;
}

export function isReturnStatementMachine(
  machine: TokenSubmachine,
): machine is ReturnStatementMachine {
  return machine instanceof ReturnStatementMachine;
}

export function isThrowStatementMachine(
  machine: TokenSubmachine,
): machine is ThrowStatementMachine {
  return machine instanceof ThrowStatementMachine;
}

function staticArgumentValue(tokens: PositionedWorkflowToken[]): string | undefined {
  return tokens.length === 1 ? staticStringValue(tokens[0].token) : undefined;
}

function secondArrowParameter(prefix: string): string | undefined {
  const parameterList = callbackParameterList(prefix);
  if (!parameterList || !/^\s*(?:async\s*)?$/u.test(parameterList.before)) {
    return undefined;
  }
  return simpleParameterName(parameterList.parameters[1]);
}

function functionExpressionCallback(prefix: string): { stepParameter?: string } | undefined {
  const parameterList = callbackParameterList(prefix);
  if (
    !parameterList ||
    !/^\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*$/u.test(parameterList.before)
  ) {
    return undefined;
  }
  const stepParameter = simpleParameterName(parameterList.parameters[1]);
  return stepParameter ? { stepParameter } : {};
}

function callbackParameterList(
  source: string,
): { before: string; parameters: WorkflowToken[][] } | undefined {
  const tokens: Array<{ token: WorkflowToken; start: number }> = [];
  let offset = 0;
  for (const token of tokenizeWorkflowSource(source)) {
    const start = offset;
    offset += token.value.length;
    if (!isTriviaToken(token)) {
      tokens.push({ token, start });
    }
  }
  if (tokens.at(-1)?.token.value !== ")") {
    return undefined;
  }

  let parentheses = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const current = tokens[index];
    if (current.token.value === ")") {
      parentheses += 1;
      continue;
    }
    if (current.token.value !== "(") {
      continue;
    }

    parentheses -= 1;
    if (parentheses === 0) {
      return {
        before: source.slice(0, current.start),
        parameters: splitTopLevelParameters(tokens.slice(index + 1, -1).map(({ token }) => token)),
      };
    }
  }
  return undefined;
}

function splitTopLevelParameters(tokens: WorkflowToken[]): WorkflowToken[][] {
  const parameters: WorkflowToken[][] = [[]];
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let angles = 0;

  for (const token of tokens) {
    const value = token.value;
    if (value === "," && parentheses === 0 && braces === 0 && brackets === 0 && angles === 0) {
      parameters.push([]);
      continue;
    }
    parameters.at(-1)!.push(token);

    if (value === "(") {
      parentheses += 1;
    } else if (value === ")") {
      parentheses -= 1;
    } else if (value === "{") {
      braces += 1;
    } else if (value === "}") {
      braces -= 1;
    } else if (value === "[") {
      brackets += 1;
    } else if (value === "]") {
      brackets -= 1;
    } else if (/^<+$/u.test(value)) {
      angles += value.length;
    } else if (/^>+$/u.test(value)) {
      angles = Math.max(0, angles - value.length);
    }
  }

  return parameters;
}

function simpleParameterName(tokens: WorkflowToken[] | undefined): string | undefined {
  const firstToken = tokens?.[0]?.value === "..." ? tokens[1] : tokens?.[0];
  return firstToken?.type === "IdentifierName" ? firstToken.value : undefined;
}

function statementEndsBefore(
  positioned: PositionedWorkflowToken,
  branch: BranchProgress,
  context: TokenMachineContext,
): boolean {
  const previous = branch.lastToken;
  if (
    !previous ||
    branch.firstStatementToken === "if" ||
    branch.statementDepth === undefined ||
    !sameDepth(context.depth, branch.statementDepth) ||
    !tokenCanEndStatement(previous.token)
  ) {
    return false;
  }
  if (positioned.token.value === "else") {
    return true;
  }
  return (
    hasLineTerminatorBetween(previous, positioned, context.source) &&
    !tokenContinuesStatement(positioned.token)
  );
}

function hasLineTerminatorBetween(
  previous: PositionedWorkflowToken,
  current: PositionedWorkflowToken,
  source: string,
): boolean {
  return /[\n\r\u2028\u2029]/u.test(source.slice(previous.end, current.start));
}

const NON_TERMINATING_KEYWORDS = new Set([
  "await",
  "case",
  "const",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "var",
  "void",
  "yield",
]);

function tokenCanEndStatement(token: WorkflowToken): boolean {
  if (token.type === "IdentifierName") {
    return !NON_TERMINATING_KEYWORDS.has(token.value);
  }
  if (
    token.type === "NumericLiteral" ||
    token.type === "StringLiteral" ||
    token.type === "NoSubstitutionTemplate" ||
    token.type === "TemplateTail" ||
    token.type === "RegularExpressionLiteral"
  ) {
    return true;
  }
  return (
    token.value === ")" ||
    token.value === "]" ||
    token.value === "}" ||
    token.value === "++" ||
    token.value === "--"
  );
}

const CONTINUING_TOKENS = new Set([
  ".",
  "?.",
  "(",
  "[",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&&",
  "||",
  "??",
  "?",
  ":",
  ",",
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&&=",
  "||=",
  "??=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "=>",
  "==",
  "===",
  "!=",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "<<",
  ">>",
  ">>>",
  "&",
  "|",
  "^",
  "as",
  "in",
  "instanceof",
  "satisfies",
]);

function tokenContinuesStatement(token: WorkflowToken): boolean {
  return (
    CONTINUING_TOKENS.has(token.value) ||
    token.type === "NoSubstitutionTemplate" ||
    token.type === "TemplateHead"
  );
}

function isStatementTerminator(
  value: string,
  branch: BranchProgress,
  context: TokenMachineContext,
): boolean {
  return (
    value === ";" &&
    branch.statementDepth !== undefined &&
    sameDepth(context.depth, branch.statementDepth)
  );
}

function sameDepth(
  left: TokenMachineContext["depth"],
  right: TokenMachineContext["depth"],
): boolean {
  return (
    left.parentheses === right.parentheses &&
    left.braces === right.braces &&
    left.brackets === right.brackets
  );
}
