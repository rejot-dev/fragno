import type { AutomationExternalEntityRef } from "@fragno-dev/backoffice-api/v0/automation";
import { z } from "zod";

export type ExternalIdentity = AutomationExternalEntityRef;

/** Only a Telegram user is one person; a chat can speak for several, or for none. */
export function canLinkExternalIdentity(identity: ExternalIdentity): boolean {
  return identity.source !== "telegram" || identity.type === "user";
}

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
  identity: externalIdentitySchema.refine(
    canLinkExternalIdentity,
    "This external identity cannot be linked to a user.",
  ),
  userId: z.string().trim().min(1),
  verifiedByClaimId: z.string().trim().min(1),
});

export const revokeExternalIdentityInputSchema = z.strictObject({
  identity: externalIdentitySchema,
  expectedUserId: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative(),
});

export const listExternalIdentityBindingsInputSchema = z.strictObject({
  pageSize: z.number().int().positive().max(500),
  cursor: z.string().min(1).nullable(),
});

export type ListExternalIdentityBindingsInput = z.infer<
  typeof listExternalIdentityBindingsInputSchema
>;
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

export type ExternalIdentityBindingPage = {
  bindings: ExternalIdentityBinding[];
  /** Continues the listing; null on the last page. */
  cursor: string | null;
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
