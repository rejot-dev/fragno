// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/ivm/change-type.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {Enum} from '../../../shared/src/enum.ts';
import * as ChangeTypeEnum from './change-type-enum.ts';

export {ChangeTypeEnum as ChangeType};
export type ChangeType = Enum<typeof ChangeTypeEnum>;
