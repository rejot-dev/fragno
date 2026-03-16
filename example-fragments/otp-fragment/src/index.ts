import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { otpFragmentDefinition } from "./definition";
import type {
  IOtpService,
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
  OtpTimestamp,
  ResolvedOtpConfirmedHookPayload,
  ResolvedOtpExpiredHookPayload,
  ResolvedOtpIssuedHookPayload,
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
import { otpSchema } from "./schema";
import { otpStatusSchema, otpTypeSchema } from "./types";
import type { OtpErrorCode, OtpStatus, OtpType } from "./types";

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

export { otpFragmentDefinition } from "./definition";
export { otpRoutesFactory } from "./routes";
export { otpSchema } from "./schema";
export { otpStatusSchema, otpTypeSchema };
export type { FragnoRouteConfig } from "@fragno-dev/core";
export type {
  IOtpService,
  OtpConfirmResult,
  OtpFragmentConfig,
  OtpInvalidateResult,
  OtpIssueResult,
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
  OtpTimestamp,
  OtpType,
  ResolvedOtpIssuedHookPayload,
  ResolvedOtpConfirmedHookPayload,
  ResolvedOtpExpiredHookPayload,
};
