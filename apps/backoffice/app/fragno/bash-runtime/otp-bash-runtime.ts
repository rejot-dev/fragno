import type { AutomationIdentityClaimRecord, OtpRuntime } from "../runtime-tools/families/otp";

export type { AutomationIdentityClaimRecord };
export type OtpBashRuntime = OtpRuntime;

export type RegisteredOtpBashCommandContext = {
  runtime: OtpBashRuntime;
};

export const createOtpBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): OtpBashRuntime => ({
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
      externalId: issued.externalId,
      code: issued.code,
      type: issued.type,
    };
  },
});
