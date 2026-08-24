import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { OtpObject } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { buildIdentityClaimCompletionUrl } from "@/fragno/otp";

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
  scope,
  kernel,
  execution,
}: {
  object: OtpObject;
  config: BackofficeRuntimeConfig;
  scope: Extract<BackofficeResolvedScope, { kind: "org" }>;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): OtpRuntime => ({
  createClaim: async ({ ttlMinutes }) => {
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
          scope: { kind: "org", orgId: scope.organization.id },
          actor,
          expiresInMinutes: ttlMinutes,
        }),
    });

    return {
      url: buildIdentityClaimCompletionUrl(
        publicBaseUrl,
        scope.organization.slug,
        issued.externalId,
        issued.code,
      ),
      otpId: issued.otpId,
      externalId: issued.externalId,
      code: issued.code,
      actor,
      type: issued.type,
    };
  },
});
