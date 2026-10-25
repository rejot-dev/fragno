// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/planner/planner-source.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {
  Condition,
  Ordering,
  SimpleCondition,
} from '../../../zero-protocol/src/ast.ts';
import {
  PlannerConnection,
  type ConnectionCostModel,
} from './planner-connection.ts';
import type {PlannerConstraint} from './planner-constraint.ts';

export type {ConnectionCostModel};

export class PlannerSource {
  readonly name: string;
  readonly #model: ConnectionCostModel;

  constructor(name: string, model: ConnectionCostModel) {
    this.name = name;
    this.#model = model;
  }

  connect(
    sort: Ordering,
    filters: Condition | undefined,
    isRoot: boolean,
    baseConstraints?: PlannerConstraint,
    limit?: number,
    pushed?: ReadonlySet<SimpleCondition>,
  ): PlannerConnection {
    return new PlannerConnection(
      this.name,
      this.#model,
      sort,
      filters,
      isRoot,
      baseConstraints,
      limit,
      undefined,
      pushed,
    );
  }
}
