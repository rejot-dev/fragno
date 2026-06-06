import type { AutomationIdentityClaimRecord, OtpRuntime } from "./otp";

export type { AutomationIdentityClaimRecord, OtpRuntime };

export type RegisteredOtpCommandContext = {
  runtime: OtpRuntime;
};

export const createOtpRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): OtpRuntime => ({
  createClaim: async ({ source, externalActorId, ttlMinutes }) => {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      throw new Error("otp.identity.create-claim requires an organisation id");
    }

    const publicBaseUrl = env.DOCS_PUBLIC_BASE_URL?.trim();
    if (!publicBaseUrl) {
      throw new Error(
        "DOCS_PUBLIC_BASE_URL must be configured before issuing automation identity claims.",
      );
    }

    const otpDo = env.OTP.get(env.OTP.idFromName(normalizedOrgId));
    const issued = await otpDo.issueIdentityClaim({
      orgId: normalizedOrgId,
      linkSource: source,
      externalActorId,
      expiresInMinutes: ttlMinutes,
      publicBaseUrl,
    });

    return {
      url: issued.url,
      otpId: issued.otpId,
      externalId: issued.externalId,
      code: issued.code,
      type: issued.type,
    };
  },
});
