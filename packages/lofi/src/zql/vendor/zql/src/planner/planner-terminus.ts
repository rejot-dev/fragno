// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/planner/planner-terminus.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {PlanDebugger} from './planner-debug.ts';
import type {
  CostEstimate,
  JoinOrConnection,
  PlannerNode,
} from './planner-node.ts';

export class PlannerTerminus {
  readonly kind = 'terminus' as const;
  readonly #input: Exclude<PlannerNode, PlannerTerminus>;

  constructor(input: Exclude<PlannerNode, PlannerTerminus>) {
    this.#input = input;
  }

  get pinned(): boolean {
    return true;
  }

  closestJoinOrSource(): JoinOrConnection {
    return this.#input.closestJoinOrSource();
  }

  propagateConstraints(planDebugger?: PlanDebugger): void {
    this.#input.propagateConstraints([], undefined, this, planDebugger);
  }

  estimateCost(planDebugger?: PlanDebugger): CostEstimate {
    // Terminus starts the cost estimation flow with empty branch pattern
    return this.#input.estimateCost(1, [], planDebugger);
  }

  /**
   * Propagate unlimiting when a parent join is flipped.
   * Terminus doesn't participate in unlimiting.
   */
  propagateUnlimitFromFlippedJoin(): void {
    // No-op: terminus doesn't need to unlimit anything
  }
}
