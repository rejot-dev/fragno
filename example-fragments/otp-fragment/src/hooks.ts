import type { HookFn } from "@fragno-dev/db";

import type { OtpPayload, OtpType } from "./types";

interface OtpHookPayload {
  id: string;
  externalId: string;
  type: OtpType;
  code: string;
  payload?: OtpPayload;
}

export interface OtpIssuedHookPayload extends OtpHookPayload {
  createdAt: Date;
}

export interface OtpConfirmedHookPayload extends OtpHookPayload {
  confirmedAt: Date;
  confirmationPayload?: OtpPayload;
}

export interface OtpExpiredHookPayload extends OtpHookPayload {
  expiredAt: Date;
}

export interface OtpHookContext {
  idempotencyKey: string;
  hookId: string;
}

export interface OtpHooks {
  onOtpIssued?: (payload: OtpIssuedHookPayload, context: OtpHookContext) => Promise<void> | void;
  onOtpConfirmed?: (
    payload: OtpConfirmedHookPayload,
    context: OtpHookContext,
  ) => Promise<void> | void;
  onOtpExpired?: (payload: OtpExpiredHookPayload, context: OtpHookContext) => Promise<void> | void;
}

type DurableOtpIssuedHookPayload = Omit<OtpIssuedHookPayload, "createdAt">;
type DurableOtpConfirmedHookPayload = Omit<OtpConfirmedHookPayload, "confirmedAt">;
type DurableOtpExpiredHookPayload = Omit<OtpExpiredHookPayload, "expiredAt">;

export type OtpHooksMap = {
  onOtpIssued: HookFn<DurableOtpIssuedHookPayload>;
  onOtpConfirmed: HookFn<DurableOtpConfirmedHookPayload>;
  onOtpExpired: HookFn<DurableOtpExpiredHookPayload>;
  expireOtp: HookFn<{ otpId: string }>;
};
