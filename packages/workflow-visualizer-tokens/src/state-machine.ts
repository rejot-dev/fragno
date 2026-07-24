import type { ActiveConstruct, DelimiterDepth, SourceRange } from "./model.ts";
import type { WorkflowToken } from "./tokenizer.ts";

export interface PositionedWorkflowToken {
  token: WorkflowToken;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface TokenMachineContext {
  source: string;
  depth: DelimiterDepth;
}

export type TokenSubmachineStatus = "active" | "complete";

/** One independently evolving construct in the token stream. */
export interface TokenSubmachine {
  readonly id: string;
  readonly kind: ActiveConstruct["kind"];
  readonly parentId?: string;
  readonly phase: string;
  readonly source: SourceRange;

  consume(token: PositionedWorkflowToken, context: TokenMachineContext): TokenSubmachineStatus;
  finish?(context: TokenMachineContext): TokenSubmachineStatus;
  childCompleted?(child: TokenSubmachine, context: TokenMachineContext): TokenSubmachineStatus;
}

/**
 * Owns active submachines and propagates tokens child-first. A child can complete
 * its parent through `childCompleted`, which makes nested statement machines such
 * as `else if` composable without teaching the root tokenizer their grammar.
 */
export class TokenSubmachineRuntime {
  readonly #machines: TokenSubmachine[] = [];

  add(machine: TokenSubmachine): void {
    if (this.#machines.some((active) => active.id === machine.id)) {
      throw new Error(`Token submachine ${JSON.stringify(machine.id)} is already active.`);
    }
    this.#machines.push(machine);
  }

  consume(token: PositionedWorkflowToken, context: TokenMachineContext): void {
    for (const machine of this.#machines.toReversed()) {
      if (!this.#machines.includes(machine)) {
        continue;
      }
      if (machine.consume(token, context) === "complete") {
        this.complete(machine, context);
      }
    }
  }

  finish(context: TokenMachineContext): void {
    for (const machine of this.#machines.toReversed()) {
      if (!this.#machines.includes(machine)) {
        continue;
      }
      if (machine.finish?.(context) === "complete") {
        this.complete(machine, context);
      }
    }
  }

  all<T extends TokenSubmachine>(predicate: (machine: TokenSubmachine) => machine is T): T[] {
    return this.#machines.filter(predicate);
  }

  findLast<T extends TokenSubmachine>(
    predicate: (machine: TokenSubmachine) => machine is T,
  ): T | undefined {
    return this.#machines.findLast(predicate);
  }

  has(predicate: (machine: TokenSubmachine) => boolean): boolean {
    return this.#machines.some(predicate);
  }

  activeConstructs(): ActiveConstruct[] {
    return this.#machines.map((machine) => ({
      kind: machine.kind,
      id: machine.id,
      phase: machine.phase,
      ...(machine.parentId ? { parentId: machine.parentId } : {}),
    }));
  }

  private complete(machine: TokenSubmachine, context: TokenMachineContext): void {
    const index = this.#machines.indexOf(machine);
    if (index < 0) {
      return;
    }
    this.#machines.splice(index, 1);

    if (!machine.parentId) {
      return;
    }
    const parent = this.#machines.find((candidate) => candidate.id === machine.parentId);
    if (parent?.childCompleted?.(machine, context) === "complete") {
      this.complete(parent, context);
    }
  }
}
