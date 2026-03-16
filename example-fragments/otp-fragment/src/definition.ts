import { defineFragment } from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";

import type {
  OtpConfirmedHookPayload,
  OtpExpiredHookPayload,
  OtpPayload,
  OtpHooks,
  OtpHooksMap,
  OtpIssuedHookPayload,
  OtpTimestamp,
  ResolvedOtpConfirmedHookPayload,
  ResolvedOtpExpiredHookPayload,
  ResolvedOtpIssuedHookPayload,
} from "./hooks";
import {
  generateOtpCode,
  normalizeOtpCode,
  validateOtpCodeConfig,
  type OtpCodeConfig,
} from "./otp-code";
import { otpSchema } from "./schema";
import type { OtpErrorCode, OtpType } from "./types";

const DEFAULT_EXPIRY_MINUTES = 15;

export interface OtpIssueResult extends OtpIssuedHookPayload {}

export interface OtpConfirmResult {
  confirmed: boolean;
  confirmedAt?: OtpTimestamp;
  error?: OtpErrorCode;
}

export interface OtpInvalidateResult {
  invalidatedCount: number;
}

export interface IOtpService {
  issueOtp(
    externalId: string,
    type: OtpType,
    durationMinutes?: number,
    payload?: OtpPayload | null,
  ): TxResult<OtpIssueResult>;
  confirmOtp(externalId: string, code: string, type: OtpType): TxResult<OtpConfirmResult>;
  invalidateOtps(externalId: string, type: OtpType): TxResult<OtpInvalidateResult>;
}

export interface OtpFragmentConfig extends OtpCodeConfig {
  defaultExpiryMinutes?: number;
  hooks?: OtpHooks;
}

const isDbNowMarker = (value: unknown): value is { tag: "db-now"; offsetMs?: number } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    (value as { tag?: unknown }).tag === "db-now"
  );
};

const resolveHookTimestamp = (value: OtpTimestamp | string, baseTime: Date): Date => {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    return new Date(value);
  }

  if (isDbNowMarker(value)) {
    return new Date(baseTime.getTime() + (value.offsetMs ?? 0));
  }

  throw new Error("Unsupported OTP hook timestamp value.");
};

const resolveIssuedHookPayload = (
  payload: OtpIssuedHookPayload,
  hookCreatedAt: Date,
): ResolvedOtpIssuedHookPayload => ({
  ...payload,
  expiresAt: resolveHookTimestamp(payload.expiresAt, hookCreatedAt),
  createdAt: resolveHookTimestamp(payload.createdAt, hookCreatedAt),
});

const resolveConfirmedHookPayload = (
  payload: OtpConfirmedHookPayload,
  hookCreatedAt: Date,
): ResolvedOtpConfirmedHookPayload => ({
  ...resolveIssuedHookPayload(payload, hookCreatedAt),
  confirmedAt: resolveHookTimestamp(payload.confirmedAt, hookCreatedAt),
});

const resolveExpiredHookPayload = (
  payload: OtpExpiredHookPayload,
  hookCreatedAt: Date,
): ResolvedOtpExpiredHookPayload => ({
  ...resolveIssuedHookPayload(payload, hookCreatedAt),
  expiredAt: resolveHookTimestamp(payload.expiredAt, hookCreatedAt),
});

const buildIssuedPayload = (input: {
  id: string;
  externalId: string;
  type: OtpType;
  code: string;
  expiresAt: OtpTimestamp;
  createdAt: OtpTimestamp;
  payload: OtpPayload | null;
}): OtpIssuedHookPayload => ({
  id: input.id,
  externalId: input.externalId,
  type: input.type,
  code: input.code,
  expiresAt: input.expiresAt,
  createdAt: input.createdAt,
  payload: input.payload,
});

const buildExpiredPayload = (
  issued: OtpIssuedHookPayload,
  expiredAt: OtpTimestamp,
): OtpExpiredHookPayload => ({
  ...issued,
  expiredAt,
});

const buildConfirmedPayload = (
  issued: OtpIssuedHookPayload,
  confirmedAt: OtpTimestamp,
): OtpConfirmedHookPayload => ({
  ...issued,
  confirmedAt,
});

export const otpFragmentDefinition = defineFragment<OtpFragmentConfig>("otp")
  .extend(withDatabase(otpSchema))
  .withDependencies(({ config }) => {
    validateOtpCodeConfig(config);
    return {};
  })
  .provideHooks<OtpHooksMap>(({ defineHook, config }) => ({
    onOtpIssued: defineHook(async function (payload) {
      await config.hooks?.onOtpIssued?.(
        resolveIssuedHookPayload(payload, this.createdAt),
        this.idempotencyKey,
      );
    }),
    onOtpConfirmed: defineHook(async function (payload) {
      await config.hooks?.onOtpConfirmed?.(
        resolveConfirmedHookPayload(payload, this.createdAt),
        this.idempotencyKey,
      );
    }),
    onOtpExpired: defineHook(async function (payload) {
      await config.hooks?.onOtpExpired?.(
        resolveExpiredHookPayload(payload, this.createdAt),
        this.idempotencyKey,
      );
    }),
    expireOtp: defineHook(async function ({ otpId }) {
      const result = await this.handlerTx()
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
            return { action: "skip" as const };
          }

          const uow = forSchema(otpSchema);
          const expiredAt = uow.now();
          const issuedPayload = buildIssuedPayload({
            id: otp.id.valueOf(),
            externalId: otp.externalId,
            type: otp.type as OtpType,
            code: otp.code,
            expiresAt: otp.expiresAt,
            createdAt: otp.createdAt,
            payload: otp.payload,
          });
          const payload = buildExpiredPayload(issuedPayload, expiredAt);

          uow.update("otp", otp.id, (b) =>
            b
              .set({
                status: "expired",
                expiredAt,
              })
              .check(),
          );

          uow.triggerHook("onOtpExpired", payload);

          return {
            action: "expired" as const,
          };
        })
        .execute();

      if (result.action === "expired") {
        return;
      }
    }),
  }))
  .providesService("otp", ({ defineService, config }) =>
    defineService({
      issueOtp: function (
        externalId: string,
        type: OtpType,
        durationMinutes?: number,
        inputPayload: OtpPayload | null = null,
      ) {
        const code = generateOtpCode(config);
        const expiryMinutes =
          durationMinutes ?? config.defaultExpiryMinutes ?? DEFAULT_EXPIRY_MINUTES;

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

            const otpId = uow.create("otp", {
              externalId,
              type,
              code,
              status: "pending",
              expiresAt,
              payload: inputPayload,
              confirmedAt: null,
              expiredAt: null,
              invalidatedAt: null,
              createdAt,
            });

            const issuedPayload = buildIssuedPayload({
              id: otpId.valueOf(),
              externalId,
              type,
              code,
              expiresAt,
              createdAt,
              payload: inputPayload,
            });

            uow.triggerHook("onOtpIssued", issuedPayload);
            uow.triggerHook("expireOtp", { otpId: otpId.valueOf() }, { processAt: expiresAt });

            return issuedPayload;
          })
          .build();
      },
      confirmOtp: function (externalId: string, code: string, type: OtpType) {
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
              ),
          )
          .mutate(({ uow, retrieveResult: [otp, expiredOtp] }) => {
            if (!otp && !expiredOtp) {
              return {
                confirmed: false,
                error: "OTP_INVALID" as const,
              };
            }

            if (expiredOtp) {
              const expiredAt = uow.now();
              const issuedPayload = buildIssuedPayload({
                id: expiredOtp.id.valueOf(),
                externalId: expiredOtp.externalId,
                type: expiredOtp.type as OtpType,
                code: expiredOtp.code,
                expiresAt: expiredOtp.expiresAt,
                createdAt: expiredOtp.createdAt,
                payload: expiredOtp.payload,
              });
              const payload = buildExpiredPayload(issuedPayload, expiredAt);

              uow.update("otp", expiredOtp.id, (b) =>
                b
                  .set({
                    status: "expired",
                    expiredAt,
                  })
                  .check(),
              );

              uow.triggerHook("onOtpExpired", payload);

              return {
                confirmed: false,
                error: "OTP_EXPIRED" as const,
              };
            }

            if (!otp) {
              return {
                confirmed: false,
                error: "OTP_INVALID" as const,
              };
            }

            const confirmedAt = uow.now();
            const issuedPayload = buildIssuedPayload({
              id: otp.id.valueOf(),
              externalId: otp.externalId,
              type: otp.type as OtpType,
              code: otp.code,
              expiresAt: otp.expiresAt,
              createdAt: otp.createdAt,
              payload: otp.payload,
            });
            const payload = buildConfirmedPayload(issuedPayload, confirmedAt);

            uow.update("otp", otp.id, (b) =>
              b
                .set({
                  status: "confirmed",
                  confirmedAt,
                })
                .check(),
            );

            uow.triggerHook("onOtpConfirmed", payload);

            return {
              confirmed: true,
              confirmedAt,
            };
          })
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
