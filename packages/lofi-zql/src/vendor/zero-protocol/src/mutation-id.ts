// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zero-protocol/src/mutation-id.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import * as v from '../../shared/src/valita.ts';

export const mutationIDSchema = v.object({
  id: v.number(),
  clientID: v.string(),
});

export type MutationID = v.Infer<typeof mutationIDSchema>;
