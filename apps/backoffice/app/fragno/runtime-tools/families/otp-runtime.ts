import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { OtpObject } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
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
  kernel,
  execution,
}: {
  object: OtpObject;
  config: BackofficeRuntimeConfig;
  orgId: string;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): OtpRuntime => ({
  createClaim: async ({ ttlMinutes }) => {
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

    const initiator = execution.actors.initiator;
    if (initiator.scope !== "external" || !initiator.source) {
      throw new Error(
        "otp.identity.create-claim requires a trusted external automation initiator.",
      );
    }
    const actor = {
      scope: "external" as const,
      source: initiator.source,
      type: initiator.type,
      id: initiator.id,
    };

    const issued = await kernel.invoke({
      execution,
      operation: BACKOFFICE_PERMISSION.otp.create,
      resource: {
        kind: "external-identity",
        source: actor.source,
        externalType: actor.type,
        externalId: actor.id,
      },
      execute: async () =>
        await object.issueIdentityClaim({
          orgId: normalizedOrgId,
          actor,
          expiresInMinutes: ttlMinutes,
          publicBaseUrl,
        }),
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
