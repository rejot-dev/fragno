import { defineFragment } from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";

import { OtpIssueError } from "./errors";
import type { OtpHooks, OtpHooksMap } from "./hooks";
import {
  generateOtpCode,
  normalizeOtpCode,
  validateOtpCodeConfig,
  type OtpCodeConfig,
} from "./otp-code";
import { otpSchema } from "./schema";
import type { OtpErrorCode, OtpPayload, OtpStatus, OtpType } from "./types";

const DEFAULT_EXPIRY_MINUTES = 15;

export const MAX_OTP_REQUEST_ID_LENGTH = 128;

export type IssueOtpInput = {
  externalId: string;
  type: OtpType;
  durationMinutes?: number;
  payload?: OtpPayload | null;
  /**
   * Caller-owned identity for this issuance. It becomes the OTP record's `id`, so retries return
   * the same OTP. `externalId` instead identifies the subject and may have multiple issuances.
   */
  requestId?: string;
};

export interface OtpIssueResult {
  id: string;
  externalId: string;
  type: OtpType;
  status: OtpStatus;
  code: string;
  payload?: OtpPayload;
}

type IssuedOtp = Omit<OtpIssueResult, "status">;

export type OtpConfirmResult =
  | {
      confirmed: true;
      requestId: string;
      status: "confirmation_recorded" | "already_confirmed";
    }
  | {
      confirmed: false;
      error: OtpErrorCode;
    };

export interface OtpInvalidateResult {
  invalidatedCount: number;
}

export interface IOtpService {
  issueOtp(input: IssueOtpInput): TxResult<OtpIssueResult>;
  confirmOtp(
    externalId: string,
    code: string,
    type: OtpType,
    confirmationPayload?: OtpPayload,
  ): TxResult<OtpConfirmResult>;
  invalidateOtps(externalId: string, type: OtpType): TxResult<OtpInvalidateResult>;
}

export interface OtpFragmentConfig extends OtpCodeConfig {
  defaultExpiryMinutes?: number;
  hooks?: OtpHooks;
}

const resolveOtpRequestId = (requestId?: string): string | null => {
  if (requestId === undefined) {
    return null;
  }

  const normalizedRequestId = requestId.trim();
  if (normalizedRequestId.length === 0) {
    throw new OtpIssueError("OTP_REQUEST_ID_EMPTY", "OTP request id must not be empty.");
  }

  if (normalizedRequestId.length > MAX_OTP_REQUEST_ID_LENGTH) {
    throw new OtpIssueError(
      "OTP_REQUEST_ID_TOO_LONG",
      `OTP request id must be at most ${MAX_OTP_REQUEST_ID_LENGTH} characters.`,
    );
  }

  return normalizedRequestId;
};

export const otpFragmentDefinition = defineFragment<OtpFragmentConfig>("otp")
  .extend(withDatabase(otpSchema))
  .withDependencies(({ config }) => {
    validateOtpCodeConfig(config);
    return {};
  })
  .provideHooks<OtpHooksMap>(({ defineHook, config }) => {
    const hookContext = (context: { idempotencyKey: string; hookId: { toString(): string } }) => ({
      idempotencyKey: context.idempotencyKey,
      hookId: context.hookId.toString(),
    });

    return {
      onOtpIssued: defineHook(async function (payload) {
        await config.hooks?.onOtpIssued?.(
          { ...payload, createdAt: this.createdAt },
          hookContext(this),
        );
      }),
      onOtpConfirmed: defineHook(async function (payload) {
        await config.hooks?.onOtpConfirmed?.(
          { ...payload, confirmedAt: this.createdAt },
          hookContext(this),
        );
      }),
      onOtpExpired: defineHook(async function (payload) {
        await config.hooks?.onOtpExpired?.(
          { ...payload, expiredAt: this.createdAt },
          hookContext(this),
        );
      }),
      expireOtp: defineHook(async function ({ otpId }) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(otpSchema).findFirst("otp", (b) =>
              b.whereIndex("idx_otp_id_status_expiresAt", (eb) =>
                eb.and(
                  eb("id", "=", otpId),
                  eb("status", "=", "pending"),
                  eb("expiresAt", "<=", eb.now()),
                ),
              ),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [otp] }) => {
            if (!otp) {
              return;
            }

            const uow = forSchema(otpSchema);
            const expiredAt = uow.now();

            uow.update("otp", otp.id, (b) =>
              b
                .set({
                  status: "expired",
                  expiredAt,
                })
                .check(),
            );

            uow.triggerHook("onOtpExpired", {
              id: otp.id.valueOf(),
              externalId: otp.externalId,
              type: otp.type,
              code: otp.code,
              payload: otp.payload ?? undefined,
            });
          })
          .execute();
      }),
    };
  })
  .providesService("otp", ({ defineService, config }) =>
    defineService({
      issueOtp: function (input: IssueOtpInput) {
        const { externalId, type } = input;
        const requestId = resolveOtpRequestId(input.requestId);
        const expiryMinutes =
          input.durationMinutes ?? config.defaultExpiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
        const payload = input.payload ?? null;

        return this.serviceTx(otpSchema)
          .retrieve((uow) =>
            uow
              .findFirst("otp", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", requestId ?? "")),
              )
              .findFirst("otp", (b) =>
                b.whereIndex("idx_otp_id_status_expiresAt", (eb) =>
                  eb.and(
                    eb("id", "=", requestId ?? ""),
                    eb("status", "=", "pending"),
                    eb("expiresAt", "<=", eb.now()),
                  ),
                ),
              )
              .find("otp", (b) =>
                b.whereIndex("idx_otp_externalId_type_status", (eb) =>
                  eb.and(
                    eb("externalId", "=", externalId),
                    eb("type", "=", type),
                    eb("status", "=", "pending"),
                  ),
                ),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [existingOtp, expiredRequestedOtp, pendingOtps],
            }): OtpIssueResult => {
              if (existingOtp) {
                if (existingOtp.externalId !== externalId || existingOtp.type !== type) {
                  throw new OtpIssueError(
                    "OTP_REQUEST_ID_CONFLICT",
                    "OTP request id cannot be reused for another externalId or type.",
                  );
                }

                const issuedOtp: IssuedOtp = {
                  id: existingOtp.id.valueOf(),
                  externalId: existingOtp.externalId,
                  type: existingOtp.type,
                  code: existingOtp.code,
                  payload: existingOtp.payload ?? undefined,
                };

                if (expiredRequestedOtp) {
                  const expiredAt = uow.now();
                  uow.update("otp", expiredRequestedOtp.id, (b) =>
                    b.set({ status: "expired", expiredAt }).check(),
                  );
                  uow.triggerHook("onOtpExpired", issuedOtp);
                  return { ...issuedOtp, status: "expired" };
                }

                return { ...issuedOtp, status: existingOtp.status };
              }

              const code = generateOtpCode(config);
              const createdAt = uow.now();
              const expiresAt = uow.now().plus({ minutes: expiryMinutes });

              for (const pendingOtp of pendingOtps) {
                uow.update("otp", pendingOtp.id, (b) =>
                  b
                    .set({
                      status: "invalidated",
                      invalidatedAt: uow.now(),
                    })
                    .check(),
                );
              }

              const createdOtpId = uow.create(
                "otp",
                {
                  ...(requestId ? { id: requestId } : {}),
                  externalId,
                  type,
                  code,
                  status: "pending",
                  expiresAt,
                  payload,
                  confirmationPayload: null,
                  confirmedAt: null,
                  expiredAt: null,
                  invalidatedAt: null,
                  createdAt,
                },
                requestId === null
                  ? {}
                  : {
                      // A concurrent request with the same caller-owned ID can only conflict on this
                      // issuance, so retry and let retrieval return the OTP created by the other call.
                      retryOnUniqueConflict: () => true,
                    },
              );

              const issuedOtp: IssuedOtp = {
                id: createdOtpId.valueOf(),
                externalId,
                type,
                code,
                payload: payload ?? undefined,
              };

              uow.triggerHook("onOtpIssued", issuedOtp);
              uow.triggerHook(
                "expireOtp",
                { otpId: createdOtpId.valueOf() },
                { processAt: expiresAt },
              );

              return { ...issuedOtp, status: "pending" };
            },
          )
          .build();
      },
      confirmOtp: function (
        externalId: string,
        code: string,
        type: OtpType,
        confirmationPayload: OtpPayload | null = null,
      ) {
        const normalizedCode = normalizeOtpCode(code, config);

        return this.serviceTx(otpSchema)
          .retrieve((uow) =>
            uow
              .findFirst("otp", (b) =>
                b.whereIndex("idx_otp_externalId_type_status_code_expiresAt", (eb) =>
                  eb.and(
                    eb("externalId", "=", externalId),
                    eb("type", "=", type),
                    eb("status", "=", "pending"),
                    eb("code", "=", normalizedCode),
                    eb("expiresAt", ">", eb.now()),
                  ),
                ),
              )
              .findFirst("otp", (b) =>
                b.whereIndex("idx_otp_externalId_type_status_code_expiresAt", (eb) =>
                  eb.and(
                    eb("externalId", "=", externalId),
                    eb("type", "=", type),
                    eb("status", "=", "pending"),
                    eb("code", "=", normalizedCode),
                    eb("expiresAt", "<=", eb.now()),
                  ),
                ),
              )
              .findFirst("otp", (b) =>
                b.whereIndex("idx_otp_externalId_type_status_code_expiresAt", (eb) =>
                  eb.and(
                    eb("externalId", "=", externalId),
                    eb("type", "=", type),
                    eb("status", "=", "confirmed"),
                    eb("code", "=", normalizedCode),
                    eb("expiresAt", ">", eb.now()),
                  ),
                ),
              )
              .findFirst("otp", (b) =>
                b
                  .whereIndex("idx_otp_externalId_type_createdAt", (eb) =>
                    eb.and(eb("externalId", "=", externalId), eb("type", "=", type)),
                  )
                  .orderByIndex("idx_otp_externalId_type_createdAt", "desc"),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [otp, expiredOtp, confirmedOtp, latestOtp],
            }): OtpConfirmResult => {
              const isLatestOtp = (candidate: typeof otp) => {
                return candidate && latestOtp && candidate.id.valueOf() === latestOtp.id.valueOf();
              };
              const latestPendingOtp = isLatestOtp(otp) ? otp : null;
              const latestExpiredOtp = isLatestOtp(expiredOtp) ? expiredOtp : null;
              const latestConfirmedOtp = isLatestOtp(confirmedOtp) ? confirmedOtp : null;

              if (!latestPendingOtp && !latestExpiredOtp && !latestConfirmedOtp) {
                return {
                  confirmed: false,
                  error: "OTP_INVALID" as const,
                };
              }

              if (latestExpiredOtp) {
                const expiredAt = uow.now();

                uow.update("otp", latestExpiredOtp.id, (b) =>
                  b
                    .set({
                      status: "expired",
                      expiredAt,
                    })
                    .check(),
                );

                uow.triggerHook("onOtpExpired", {
                  id: latestExpiredOtp.id.valueOf(),
                  externalId: latestExpiredOtp.externalId,
                  type: latestExpiredOtp.type,
                  code: latestExpiredOtp.code,
                  payload: latestExpiredOtp.payload ?? undefined,
                });

                return {
                  confirmed: false,
                  error: "OTP_EXPIRED" as const,
                };
              }

              if (!latestPendingOtp) {
                if (!latestConfirmedOtp) {
                  return {
                    confirmed: false,
                    error: "OTP_INVALID" as const,
                  };
                }

                return {
                  confirmed: true,
                  requestId: latestConfirmedOtp.id.valueOf(),
                  status: "already_confirmed",
                };
              }

              const confirmedAt = uow.now();

              uow.update("otp", latestPendingOtp.id, (b) =>
                b
                  .set({
                    status: "confirmed",
                    confirmationPayload: confirmationPayload ?? null,
                    confirmedAt,
                  })
                  .check(),
              );

              uow.triggerHook("onOtpConfirmed", {
                id: latestPendingOtp.id.valueOf(),
                externalId: latestPendingOtp.externalId,
                type: latestPendingOtp.type,
                code: latestPendingOtp.code,
                payload: latestPendingOtp.payload ?? undefined,
                confirmationPayload: confirmationPayload ?? undefined,
              });

              return {
                confirmed: true,
                requestId: latestPendingOtp.id.valueOf(),
                status: "confirmation_recorded",
              };
            },
          )
          .build();
      },
      invalidateOtps: function (externalId: string, type: OtpType) {
        return this.serviceTx(otpSchema)
          .retrieve((uow) =>
            uow.find("otp", (b) =>
              b.whereIndex("idx_otp_externalId_type_status", (eb) =>
                eb.and(
                  eb("externalId", "=", externalId),
                  eb("type", "=", type),
                  eb("status", "=", "pending"),
                ),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [pendingOtps] }) => {
            for (const otp of pendingOtps) {
              uow.update("otp", otp.id, (b) =>
                b
                  .set({
                    status: "invalidated",
                    invalidatedAt: uow.now(),
                  })
                  .check(),
              );
            }

            return {
              invalidatedCount: pendingOtps.length,
            };
          })
          .build();
      },
    }),
  )
  .build();
