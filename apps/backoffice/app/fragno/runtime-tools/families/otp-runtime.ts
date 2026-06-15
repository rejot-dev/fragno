import type { OtpObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";

import type { OtpRuntime } from "./otp";

export type { OtpRuntime };

export type RegisteredOtpCommandContext = {
  runtime: OtpRuntime;
};

export const createUnavailableOtpRuntime = (message: string): OtpRuntime => ({
  createClaim: async () => {
    throw new Error(message);
  },
});

export const createOtpRuntime = ({
  object,
  config,
  orgId,
}: {
  object: OtpObject;
  config: BackofficeRuntimeConfig;
  orgId: string;
}): OtpRuntime => ({
  createClaim: async ({ actor, ttlMinutes }) => {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      throw new Error("otp.identity.create-claim requires an organisation id");
    }

    const publicBaseUrl = config.docsPublicBaseUrl?.trim();
    if (!publicBaseUrl) {
      throw new Error(
        "DOCS_PUBLIC_BASE_URL must be configured before issuing automation identity claims.",
      );
    }

    const issued = await object.issueIdentityClaim({
      orgId: normalizedOrgId,
      actor,
      expiresInMinutes: ttlMinutes,
      publicBaseUrl,
    });

    return {
      url: issued.url,
      otpId: issued.otpId,
      externalId: issued.externalId,
      code: issued.code,
      actor,
      type: issued.type,
    };
  },
});
