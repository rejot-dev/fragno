// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/error.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export type PlannerExceptionKind = 'max_flippable_joins';

export class PlannerException extends Error {
  readonly kind: PlannerExceptionKind;

  constructor(kind: PlannerExceptionKind, message: string) {
    super(message);
    this.name = 'PlannerException';
    this.kind = kind;
  }
}
