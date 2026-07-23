import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { otpFragmentDefinition } from "./definition";
import type {
  IOtpService,
  IssueOtpInput,
  OtpConfirmResult,
  OtpFragmentConfig,
  OtpInvalidateResult,
  OtpIssueResult,
} from "./definition";
import type {
  OtpConfirmedHookPayload,
  OtpExpiredHookPayload,
  OtpHooks,
  OtpHooksMap,
  OtpIssuedHookPayload,
} from "./hooks";
import { otpRoutesFactory } from "./routes";
import type {
  OtpConfirmInput,
  OtpConfirmOutput,
  OtpInvalidateInput,
  OtpInvalidateOutput,
  OtpIssueInput,
  OtpIssueOutput,
} from "./routes";
import { otpStatusSchema, otpTypeSchema } from "./types";
import type { OtpErrorCode, OtpPayload, OtpStatus, OtpType } from "./types";

export const otpRoutes = [otpRoutesFactory] as const;

export function createOtpFragment(
  config: OtpFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(otpFragmentDefinition)
    .withConfig(config)
    .withRoutes(otpRoutes)
    .withOptions(options)
    .build();
}

export function createOtpFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(otpFragmentDefinition, fragnoConfig, otpRoutes);

  return {
    useIssueOtp: builder.createMutator("POST", "/otp/issue"),
    useConfirmOtp: builder.createMutator("POST", "/otp/confirm"),
    useInvalidateOtps: builder.createMutator("POST", "/otp/invalidate"),
  };
}

export { MAX_OTP_REQUEST_ID_LENGTH, otpFragmentDefinition } from "./definition";
export { OtpIssueError, type OtpIssueErrorCode } from "./errors";
export { otpRoutesFactory } from "./routes";
export { otpSchema } from "./schema";
export { otpStatusSchema, otpTypeSchema };
export type { FragnoRouteConfig } from "@fragno-dev/core";
export type {
  IOtpService,
  IssueOtpInput,
  OtpConfirmResult,
  OtpFragmentConfig,
  OtpInvalidateResult,
  OtpIssueResult,
  OtpPayload,
  OtpHooks,
  OtpHooksMap,
  OtpIssuedHookPayload,
  OtpConfirmedHookPayload,
  OtpExpiredHookPayload,
  OtpIssueInput,
  OtpIssueOutput,
  OtpConfirmInput,
  OtpConfirmOutput,
  OtpInvalidateInput,
  OtpInvalidateOutput,
  OtpErrorCode,
  OtpStatus,
  OtpType,
};
