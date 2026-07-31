import { z } from "zod";

import type { AutomationExternalEntityRef } from "./actors";

export type ExternalIdentity = AutomationExternalEntityRef;

export const externalIdentitySchema: z.ZodType<ExternalIdentity> = z.strictObject({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

export const getExternalIdentityBindingInputSchema = z.strictObject({
  identity: externalIdentitySchema,
});

export const bindExternalIdentityInputSchema = z.strictObject({
  identity: externalIdentitySchema,
  userId: z.string().trim().min(1),
  verifiedByClaimId: z.string().trim().min(1),
});

export const revokeExternalIdentityInputSchema = z.strictObject({
  identity: externalIdentitySchema,
  expectedUserId: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative(),
});

export type GetExternalIdentityBindingInput = z.infer<typeof getExternalIdentityBindingInputSchema>;
export type BindExternalIdentityInput = z.infer<typeof bindExternalIdentityInputSchema>;
export type RevokeExternalIdentityInput = z.infer<typeof revokeExternalIdentityInputSchema>;

export type ActiveExternalIdentityBinding = {
  status: "active";
  id: string;
  version: number;
  identity: ExternalIdentity;
  userId: string;
  verifiedByClaimId: string;
  boundAt: Date;
};

export type RevokedExternalIdentityBinding = {
  status: "revoked";
  id: string;
  version: number;
  identity: ExternalIdentity;
  userId: string;
  verifiedByClaimId: string;
  boundAt: Date;
  revokedAt: Date;
};

export type ExternalIdentityBinding =
  | ActiveExternalIdentityBinding
  | RevokedExternalIdentityBinding;

export type BindExternalIdentityResult =
  | {
      status: "active";
      outcome: "created" | "unchanged" | "reactivated";
      bindingId: string;
      userId: string;
      version: number;
    }
  | {
      status: "revoked" | "superseded";
      outcome: "unchanged";
      bindingId: string;
      userId: string;
      version: number;
    };

export type ResolveExternalIdentityResult = { userId: string } | null;

export type RevokeExternalIdentityResult =
  | { status: "not-found" }
  | {
      status: "revoked";
      outcome: "revoked" | "unchanged";
      bindingId: string;
      userId: string;
      version: number;
    };

export type ExternalIdentityBindingConflictReason =
  | "identity-bound-to-another-user"
  | "verified-claim-used-for-another-binding"
  | "verified-claim-used-for-another-user"
  | "binding-owner-changed"
  | "binding-version-changed";

export class ExternalIdentityBindingConflictError extends Error {
  constructor(readonly reason: ExternalIdentityBindingConflictReason) {
    super(reason);
    this.name = "ExternalIdentityBindingConflictError";
  }
}

export const buildExternalIdentityBindingId = (identity: ExternalIdentity) =>
  [identity.source, identity.type, identity.id].map(encodeURIComponent).join(":");
