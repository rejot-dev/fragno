// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zero-protocol/src/error-reason.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {Enum} from '../../shared/src/enum.ts';
import * as ErrorReasonEnum from './error-reason-enum.ts';

export {ErrorReasonEnum as ErrorReason};
export type ErrorReason = Enum<typeof ErrorReasonEnum>;
