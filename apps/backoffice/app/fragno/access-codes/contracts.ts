import { z } from "zod";

import { normalizeAccessCode } from "./access-code";

export const ACCESS_CODE_MAX_PAGE_SIZE = 100;

export const accessCodeStatusSchema = z.enum(["active", "expired", "revoked"]);
export type AccessCodeStatus = z.infer<typeof accessCodeStatusSchema>;

/** An access code as administrators see it, so they can share its link again. */
export const accessCodeRecordSchema = z.strictObject({
  id: z.string().min(1),
  code: z.string().min(1),
  label: z.string().min(1),
  status: accessCodeStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  /** How many accounts the code admitted. */
  redemptionCount: z.number().int().nonnegative(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AccessCodeRecord = z.infer<typeof accessCodeRecordSchema>;

/** Where a new code comes from: generated at random, or made from its label. */
export const accessCodeSourceSchema = z.enum(["random", "label"]);
export type AccessCodeSource = z.infer<typeof accessCodeSourceSchema>;

export const createAccessCodeInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  codeSource: accessCodeSourceSchema,
  expiresInDays: z.number().int().positive().max(3650).nullable(),
});
export type CreateAccessCodeInput = z.infer<typeof createAccessCodeInputSchema>;

/** A code made from a label is taken when another code, even a revoked one, is the same. */
export type CreateAccessCodeResult =
  | { ok: true; accessCode: AccessCodeRecord }
  | { ok: false; reason: "code_taken"; code: string };

export const accessCodePageInputSchema = z.discriminatedUnion("page", [
  z.strictObject({
    page: z.literal("first"),
    pageSize: z.number().int().min(1).max(ACCESS_CODE_MAX_PAGE_SIZE),
  }),
  z.strictObject({ page: z.literal("next"), cursor: z.string().min(1) }),
]);
export type AccessCodePageInput = z.infer<typeof accessCodePageInputSchema>;

export const accessCodePageSchema = z.strictObject({
  accessCodes: z.array(accessCodeRecordSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
export type AccessCodePage = z.infer<typeof accessCodePageSchema>;

/** A cursor that is not from a previous page of access codes cannot continue the listing. */
export type AccessCodePageResult =
  | { ok: true; page: AccessCodePage }
  | { ok: false; reason: "cursor_invalid" };

export const revokeAccessCodeInputSchema = z.strictObject({
  accessCodeId: z.string().trim().min(1),
});
export type RevokeAccessCodeInput = z.infer<typeof revokeAccessCodeInputSchema>;

const canonicalAccessCodeSchema = z.string().transform(normalizeAccessCode);

export const accessCodeInputSchema = z.strictObject({ code: canonicalAccessCodeSchema });

export const redeemAccessCodeInputSchema = z.strictObject({
  code: canonicalAccessCodeSchema,
  email: z.string().min(1),
});
export type RedeemAccessCodeInput = z.infer<typeof redeemAccessCodeInputSchema>;

/** Why a code does not admit an account. Revoked and unknown codes are indistinguishable. */
export type AccessCodeRejection = "invalid" | "expired";

export type AccessCodeCheck = { ok: true } | { ok: false; reason: AccessCodeRejection };

export const accessCodeRedemptionSchema = z.strictObject({
  email: z.string().min(1),
  redeemedAt: z.iso.datetime(),
});
export type AccessCodeRedemption = z.infer<typeof accessCodeRedemptionSchema>;

export const accessCodeRedemptionsInputSchema = z.strictObject({
  code: canonicalAccessCodeSchema,
  pagination: accessCodePageInputSchema,
});
export type AccessCodeRedemptionsInput = z.infer<typeof accessCodeRedemptionsInputSchema>;

export type AccessCodeRedemptionPage = {
  redemptions: AccessCodeRedemption[];
  cursor: string | null;
  hasNextPage: boolean;
};

/** The accounts a code admitted, newest first. */
export type AccessCodeRedemptionsResult =
  | { ok: true; accessCode: AccessCodeRecord; page: AccessCodeRedemptionPage }
  | { ok: false; reason: "not_found" | "cursor_invalid" };

/** System administrator commands of the singleton OTP object, which hosts access codes. */
export type AccessCodeCommands = {
  createAccessCode(input: CreateAccessCodeInput): Promise<CreateAccessCodeResult>;
  listAccessCodes(input: AccessCodePageInput): Promise<AccessCodePageResult>;
  /** Null when no access code has that ID. Revoking a revoked code changes nothing. */
  revokeAccessCode(input: RevokeAccessCodeInput): Promise<AccessCodeRecord | null>;
  /** Tells whether a code would admit an account, without using it. */
  checkAccessCode(input: { code: string }): Promise<AccessCodeCheck>;
  /** Records that a code admits the account with this email. Admitting it again records nothing. */
  redeemAccessCode(input: RedeemAccessCodeInput): Promise<AccessCodeCheck>;
  listAccessCodeRedemptions(
    input: AccessCodeRedemptionsInput,
  ): Promise<AccessCodeRedemptionsResult>;
};
