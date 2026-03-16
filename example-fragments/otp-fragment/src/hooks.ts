import type { DbNow, HookFn } from "@fragno-dev/db";

import type { OtpType } from "./types";

export type OtpTimestamp = Date | DbNow;
export type OtpPayload = unknown;

export interface OtpBasePayload {
  id: string;
  externalId: string;
  type: OtpType;
  code: string;
  expiresAt: OtpTimestamp;
  createdAt: OtpTimestamp;
  payload: OtpPayload | null;
}

export interface ResolvedOtpBasePayload {
  id: string;
  externalId: string;
  type: OtpType;
  code: string;
  expiresAt: Date;
  createdAt: Date;
  payload: OtpPayload | null;
}

export interface OtpIssuedHookPayload extends OtpBasePayload {}

export interface ResolvedOtpIssuedHookPayload extends ResolvedOtpBasePayload {}

export interface OtpConfirmedHookPayload extends OtpBasePayload {
  confirmedAt: OtpTimestamp;
}

export interface ResolvedOtpConfirmedHookPayload extends ResolvedOtpBasePayload {
  confirmedAt: Date;
}

export interface OtpExpiredHookPayload extends OtpBasePayload {
  expiredAt: OtpTimestamp;
}

export interface ResolvedOtpExpiredHookPayload extends ResolvedOtpBasePayload {
  expiredAt: Date;
}

export interface OtpHooks {
  onOtpIssued?: (
    payload: ResolvedOtpIssuedHookPayload,
    idempotencyKey: string,
  ) => Promise<void> | void;
  onOtpConfirmed?: (
    payload: ResolvedOtpConfirmedHookPayload,
    idempotencyKey: string,
  ) => Promise<void> | void;
  onOtpExpired?: (
    payload: ResolvedOtpExpiredHookPayload,
    idempotencyKey: string,
  ) => Promise<void> | void;
}

export type OtpHooksMap = {
  onOtpIssued: HookFn<OtpIssuedHookPayload>;
  onOtpConfirmed: HookFn<OtpConfirmedHookPayload>;
  onOtpExpired: HookFn<OtpExpiredHookPayload>;
  expireOtp: HookFn<{ otpId: string }>;
};
