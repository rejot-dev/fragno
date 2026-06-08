import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { ResolvedOtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import { createDurableHookRepository, type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
  IDENTITY_LINK_TYPE,
  buildIdentityClaimCompletedAutomationEvent,
  buildIdentityClaimCompletionUrl,
  createOtpServer,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
  type OtpFragment,
} from "@/fragno/otp";

export type IssueIdentityClaimInput = {
  orgId: string;
  linkSource: string;
  externalActorId: string;
  expiresInMinutes?: number;
  publicBaseUrl: string;
};

export type IssueIdentityClaimResult = {
  ok: true;
  otpId: string;
  externalId: string;
  code: string;
  url: string;
  type: typeof IDENTITY_LINK_TYPE;
};

export type ConfirmIdentityClaimInput = {
  externalId: string;
  code: string;
  subjectUserId: string;
};

export type ConfirmIdentityClaimResult =
  | {
      ok: true;
      externalId: string;
    }
  | {
      ok: false;
      error: "INVALID_INPUT" | "OTP_INVALID" | "OTP_EXPIRED";
    };

const issueIdentityClaimInputSchema = z.object({
  orgId: z
    .string()
    .trim()
    .min(1, "orgId, linkSource, externalActorId, and publicBaseUrl are required."),
  linkSource: z
    .string()
    .trim()
    .min(1, "orgId, linkSource, externalActorId, and publicBaseUrl are required."),
  externalActorId: z
    .string()
    .trim()
    .min(1, "orgId, linkSource, externalActorId, and publicBaseUrl are required."),
  expiresInMinutes: z
    .number()
    .refine((value) => Number.isFinite(value), {
      message: "expiresInMinutes must be finite.",
    })
    .optional(),
  publicBaseUrl: z
    .string()
    .trim()
    .min(1, "orgId, linkSource, externalActorId, and publicBaseUrl are required."),
});

const confirmIdentityClaimInputSchema = z.object({
  externalId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  subjectUserId: z.string().trim().min(1),
});

export class Otp extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #host: FragmentDurableObjectHost<void, OtpFragment>;
  #fragment: OtpFragment | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createFragmentDurableObjectHost({
      name: "OTP",
      state,
      env,
      createRuntime: () =>
        createOtpServer(state, {
          hooks: {
            onOtpConfirmed: this.#handleOtpConfirmed.bind(this),
          },
        }),
      onProcessError: (error) => {
        console.error("OTP hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("OTP hook processor disabled", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  async #handleOtpConfirmed(payload: ResolvedOtpConfirmedHookPayload) {
    if (payload.type !== IDENTITY_LINK_TYPE) {
      return;
    }

    const claimResult = identityClaimPayloadSchema.safeParse(payload.payload);
    if (!claimResult.success) {
      console.warn("Ignoring confirmed identity claim OTP with invalid payload", {
        otpId: payload.id,
        type: payload.type,
        issues: claimResult.error.issues,
      });
      return;
    }

    const confirmationResult = identityClaimConfirmationPayloadSchema.safeParse(
      payload.confirmationPayload,
    );
    if (!confirmationResult.success) {
      console.warn("Ignoring confirmed identity claim OTP with invalid confirmation payload", {
        otpId: payload.id,
        type: payload.type,
        issues: confirmationResult.error.issues,
      });
      return;
    }

    const claim = claimResult.data;
    const confirmation = confirmationResult.data;

    const automationsDo = this.#env.AUTOMATIONS.get(this.#env.AUTOMATIONS.idFromName(claim.orgId));

    await automationsDo.triggerIngestEvent(
      buildIdentityClaimCompletedAutomationEvent({
        orgId: claim.orgId,
        userId: confirmation.subjectUserId,
        otp: payload,
        claim,
      }),
    );
  }

  #getFragment() {
    if (!this.#fragment) {
      throw new Error("OTP is unavailable.");
    }
    return this.#fragment;
  }

  async issueIdentityClaim(input: IssueIdentityClaimInput): Promise<IssueIdentityClaimResult> {
    const parsed = issueIdentityClaimInputSchema.parse(input);
    const fragment = this.#getFragment();
    const expiresInMinutes =
      typeof parsed.expiresInMinutes === "number"
        ? Math.max(1, Math.floor(parsed.expiresInMinutes))
        : DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES;

    const issued = await fragment.callServices(() =>
      fragment.services.otp.issueOtp(parsed.externalActorId, IDENTITY_LINK_TYPE, expiresInMinutes, {
        orgId: parsed.orgId,
        linkSource: parsed.linkSource,
        externalActorId: parsed.externalActorId,
      }),
    );

    return {
      ok: true,
      otpId: issued.id,
      externalId: issued.externalId,
      code: issued.code,
      url: buildIdentityClaimCompletionUrl(
        parsed.publicBaseUrl,
        parsed.orgId,
        issued.externalId,
        issued.code,
      ),
      type: IDENTITY_LINK_TYPE,
    };
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
  ): Promise<ConfirmIdentityClaimResult> {
    const parsed = confirmIdentityClaimInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "INVALID_INPUT" };
    }

    const { externalId, code, subjectUserId } = parsed.data;
    const fragment = this.#getFragment();
    const confirmation = await fragment.callServices(() =>
      fragment.services.otp.confirmOtp(externalId, code, IDENTITY_LINK_TYPE, {
        subjectUserId,
      }),
    );

    if (!confirmation.confirmed) {
      return { ok: false, error: confirmation.error ?? "OTP_INVALID" };
    }

    return {
      ok: true,
      externalId,
    };
  }

  getDurableHookRepository() {
    return createDurableHookRepository<DurableHookQueueOptions>(() => this.#getFragment());
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
