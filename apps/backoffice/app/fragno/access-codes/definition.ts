import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type Cursor } from "@fragno-dev/db";

import type {
  AccessCodeCheck,
  AccessCodePage,
  AccessCodeRecord,
  AccessCodeRedemptionsResult,
  AccessCodeStatus,
  CreateAccessCodeResult,
} from "./contracts";
import {
  ACCESS_CODE_ORDER_INDEX,
  ACCESS_CODE_REDEMPTION_ORDER_INDEX,
  accessCodesFragmentSchema,
} from "./schema";

type StoredAccessCode = {
  id: { externalId: string };
  code: string;
  label: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  redemptionCount: number;
  createdAt: Date;
};

type Page = { page: "first"; pageSize: number } | { page: "next"; cursor: Cursor };

/** A redemption is new the first time a code admits an email; a retried sign-up repeats it. */
export type AccessCodeRedemptionResult =
  | { ok: true; redemption: "new" | "repeat"; accessCode: { id: string; label: string } }
  | Extract<AccessCodeCheck, { ok: false }>;

/** Expiry is derived when a code is read, so nothing sweeps expired codes. */
function accessCodeStatus(code: StoredAccessCode, now: Date): AccessCodeStatus {
  if (code.revokedAt !== null) {
    return "revoked";
  }
  if (code.expiresAt !== null && code.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

function checkStoredAccessCode(code: StoredAccessCode | null, now: Date): AccessCodeCheck {
  const status = code ? accessCodeStatus(code, now) : "revoked";
  if (status === "active") {
    return { ok: true };
  }
  return { ok: false, reason: status === "revoked" ? "invalid" : status };
}

function toAccessCodeRecord(code: StoredAccessCode, now: Date): AccessCodeRecord {
  return {
    id: code.id.externalId,
    code: code.code,
    label: code.label,
    status: accessCodeStatus(code, now),
    expiresAt: code.expiresAt?.toISOString() ?? null,
    redemptionCount: code.redemptionCount,
    revokedAt: code.revokedAt?.toISOString() ?? null,
    createdAt: code.createdAt.toISOString(),
  };
}

/** Callers pass codes in canonical form and the time, so the fragment's rules are deterministic. */
export const accessCodesFragmentDefinition = defineFragment("access-codes")
  .extend(withDatabase(accessCodesFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      createAccessCode: function (input: {
        code: string;
        label: string;
        expiresAt: Date | null;
        now: Date;
      }) {
        const { now, ...accessCode } = input;
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("access_code", (b) =>
              b.whereIndex("idx_access_code_code", (eb) => eb("code", "=", accessCode.code)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): CreateAccessCodeResult => {
            if (existing) {
              return { ok: false, reason: "code_taken", code: accessCode.code };
            }
            uow.checkAbsent("access_code", "idx_access_code_code", { code: accessCode.code });
            const id = uow.create(
              "access_code",
              { ...accessCode, createdAt: now },
              {
                // A retry reads the concurrently created code and reports it taken.
                retryOnUniqueConflict: ({ error }) =>
                  error.columns?.length === 1 && error.columns[0] === "code",
              },
            );
            return {
              ok: true,
              accessCode: toAccessCodeRecord(
                { ...accessCode, id, revokedAt: null, redemptionCount: 0, createdAt: now },
                now,
              ),
            };
          })
          .build();
      },

      listAccessCodes: function (input: Page & { now: Date }) {
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("access_code", (b) => {
              const ordered = b
                .whereIndex(ACCESS_CODE_ORDER_INDEX)
                .orderByIndex(ACCESS_CODE_ORDER_INDEX, "desc");
              return input.page === "first"
                ? ordered.pageSize(input.pageSize)
                : ordered.after(input.cursor);
            }),
          )
          .transformRetrieve(
            ([page]): AccessCodePage => ({
              accessCodes: page.items.map((code) => toAccessCodeRecord(code, input.now)),
              cursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },

      revokeAccessCode: function (input: { accessCodeId: string; now: Date }) {
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("access_code", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.accessCodeId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [code] }): AccessCodeRecord | null => {
            if (!code) {
              return null;
            }
            if (code.revokedAt !== null) {
              return toAccessCodeRecord(code, input.now);
            }
            uow.update("access_code", code.id, (b) => b.set({ revokedAt: input.now }).check());
            return toAccessCodeRecord({ ...code, revokedAt: input.now }, input.now);
          })
          .build();
      },

      checkAccessCode: function (input: { code: string; now: Date }) {
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("access_code", (b) =>
              b.whereIndex("idx_access_code_code", (eb) => eb("code", "=", input.code)),
            ),
          )
          .transformRetrieve(([code]) => checkStoredAccessCode(code, input.now))
          .build();
      },

      redeemAccessCode: function (input: { code: string; email: string; now: Date }) {
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("access_code", (b) =>
                b.whereIndex("idx_access_code_code", (eb) => eb("code", "=", input.code)),
              )
              .findFirst("access_code_redemption", (b) =>
                b.whereIndex("idx_access_code_redemption_code_email", (eb) =>
                  eb.and(eb("code", "=", input.code), eb("email", "=", input.email)),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [code, existing] }): AccessCodeRedemptionResult => {
            if (!code) {
              return { ok: false, reason: "invalid" };
            }
            const check = checkStoredAccessCode(code, input.now);
            if (!check.ok) {
              return check;
            }
            const accessCode = { id: code.id.externalId, label: code.label };
            if (existing) {
              return { ok: true, redemption: "repeat", accessCode };
            }
            // Concurrent redemptions and revocations conflict on the code's version, so the count
            // stays exact and a revocation wins.
            uow.update("access_code", code.id, (b) =>
              b.set({ redemptionCount: code.redemptionCount + 1 }).check(),
            );
            uow.checkAbsent("access_code_redemption", "idx_access_code_redemption_code_email", {
              code: input.code,
              email: input.email,
            });
            uow.create(
              "access_code_redemption",
              { code: input.code, email: input.email, redeemedAt: input.now },
              {
                // A retry reads the concurrent redemption and repeats it.
                retryOnUniqueConflict: ({ error }) =>
                  error.columns?.length === 2 && error.columns.includes("email"),
              },
            );
            return { ok: true, redemption: "new", accessCode };
          })
          .build();
      },

      listAccessCodeRedemptions: function (input: { code: string; page: Page; now: Date }) {
        return this.serviceTx(accessCodesFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("access_code", (b) =>
                b.whereIndex("idx_access_code_code", (eb) => eb("code", "=", input.code)),
              )
              .findWithCursor("access_code_redemption", (b) => {
                const ordered = b
                  .whereIndex(ACCESS_CODE_REDEMPTION_ORDER_INDEX, (eb) =>
                    eb("code", "=", input.code),
                  )
                  .orderByIndex(ACCESS_CODE_REDEMPTION_ORDER_INDEX, "desc");
                return input.page.page === "first"
                  ? ordered.pageSize(input.page.pageSize)
                  : ordered.after(input.page.cursor);
              }),
          )
          .transformRetrieve(([code, page]): AccessCodeRedemptionsResult => {
            if (!code) {
              return { ok: false, reason: "not_found" };
            }
            return {
              ok: true,
              accessCode: toAccessCodeRecord(code, input.now),
              page: {
                redemptions: page.items.map((redemption) => ({
                  email: redemption.email,
                  redeemedAt: redemption.redeemedAt.toISOString(),
                })),
                cursor: page.cursor?.encode() ?? null,
                hasNextPage: page.hasNextPage,
              },
            };
          })
          .build();
      },
    }),
  )
  .build();
