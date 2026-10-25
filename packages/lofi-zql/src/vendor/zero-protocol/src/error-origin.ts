// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zero-protocol/src/error-origin.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {Enum} from '../../shared/src/enum.ts';
import * as ErrorOriginEnum from './error-origin-enum.ts';

export {ErrorOriginEnum as ErrorOrigin};
export type ErrorOrigin = Enum<typeof ErrorOriginEnum>;
