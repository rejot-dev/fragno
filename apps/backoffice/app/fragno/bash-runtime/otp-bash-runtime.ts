import { createAutomationCommands } from "../automation/commands/bash-adapter";
import { OTP_COMMAND_SPEC_LIST } from "../automation/commands/registry";
import type { IdentityCreateClaimArgs, OtpCommandHandlers } from "../automation/commands/types";
import type { BashCommandFactoryInput } from "./bash-host";

export type AutomationIdentityClaimRecord = {
  url: string;
  externalId: string;
  code: string;
  type?: string;
  expiresAt?: string;
};

export type OtpBashRuntime = {
  createClaim: (input: IdentityCreateClaimArgs) => Promise<AutomationIdentityClaimRecord>;
};

export type RegisteredOtpBashCommandContext = {
  runtime: OtpBashRuntime;
};

export type OtpBashRegistryContext = {
  otp?: RegisteredOtpBashCommandContext;
};

const otpCommandHandlers: OtpCommandHandlers<RegisteredOtpBashCommandContext> = {
  "otp.identity.create-claim": async (command, context) => {
    return {
      data: await context.runtime.createClaim(command.args),
    };
  },
};

export const createOtpBashCommands = <TContext>(input: BashCommandFactoryInput<TContext>) => {
  const otpContext = (input.context as OtpBashRegistryContext).otp;
  if (!otpContext) {
    return [];
  }

  return createAutomationCommands(
    OTP_COMMAND_SPEC_LIST,
    otpCommandHandlers,
    otpContext,
    input.commandCallsResult,
  );
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
