import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

const resolveExternalIdentityInputSchema = z.strictObject({
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const resolveExternalIdentityOutputSchema = z
  .strictObject({
    userId: z.string().trim().min(1),
  })
  .nullable();

export const identityOperations = {
  "identity.external.resolve": {
    description:
      "Resolve an active external identity binding so the workflow can choose its internal user.",
    permissions: [BACKOFFICE_PERMISSION.identity.resolve],
    input: resolveExternalIdentityInputSchema,
    output: resolveExternalIdentityOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
