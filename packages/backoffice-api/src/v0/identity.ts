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

const listExternalIdentitiesInputSchema = z.strictObject({
  limit: z.number().int().positive().max(500).optional(),
  cursor: z.string().trim().min(1).optional(),
});

const externalIdentityBindingSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  type: z.string(),
  externalId: z.string(),
  userId: z.string(),
  verifiedByClaimId: z.string(),
  status: z.enum(["active", "revoked"]),
  boundAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

const listExternalIdentitiesOutputSchema = z.strictObject({
  bindings: z.array(externalIdentityBindingSchema),
  nextCursor: z.string().nullable(),
});

export type ListExternalIdentitiesInput = z.infer<typeof listExternalIdentitiesInputSchema>;
export type ListExternalIdentitiesOutput = z.infer<typeof listExternalIdentitiesOutputSchema>;

export const identityOperations = {
  "identity.external.resolve": {
    description:
      "Resolve an active external identity binding so the workflow can choose its internal user.",
    permissions: [BACKOFFICE_PERMISSION.identity.resolve],
    input: resolveExternalIdentityInputSchema,
    output: resolveExternalIdentityOutputSchema,
  },
  "identity.external.list": {
    description:
      "List external identities bound to users in the current scope, active and revoked, ordered by source, type, and id.",
    permissions: [BACKOFFICE_PERMISSION.identity.read],
    input: listExternalIdentitiesInputSchema,
    output: listExternalIdentitiesOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
