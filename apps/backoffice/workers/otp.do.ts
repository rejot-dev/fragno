import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { HookContext } from "@fragno-dev/db";
import type { OtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import type { OtpObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { createDurableHookRepository } from "@/fragno/durable-hooks";
import {
  DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
  EMAIL_VERIFICATION_EXPIRY_HOURS,
  EMAIL_VERIFICATION_EXPIRY_MINUTES,
  EMAIL_VERIFICATION_TYPE,
  IDENTITY_LINK_TYPE,
  buildEmailVerificationUrl,
  buildIdentityClaimCompletedAutomationEvent,
  buildIdentityClaimCompletionUrl,
  createOtpServer,
  emailVerificationPayloadSchema,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
  type OtpFragment,
} from "@/fragno/otp";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

export type IssueEmailVerificationInput = {
  userId: string;
  email: string;
  publicBaseUrl: string;
  requestId: string;
};

export type IssueEmailVerificationResult =
  | {
      deliverable: true;
      requestId: string;
      userId: string;
      url: string;
      expiresInHours: number;
      type: typeof EMAIL_VERIFICATION_TYPE;
    }
  | {
      deliverable: false;
      reason: "expired" | "superseded" | "already_confirmed";
    };

export type ConfirmEmailVerificationChallengeInput = {
  userId: string;
  code: string;
};

export type ConfirmEmailVerificationChallengeResult =
  | {
      status: "confirmation_recorded";
      requestId: string;
      userId: string;
    }
  | {
      status: "already_confirmed";
    }
  | {
      status: "rejected";
      reason: "invalid_input" | "invalid" | "expired";
    };

export type IssueIdentityClaimInput = {
  orgId: string;
  actor: {
    scope: "external";
    source: string;
    type: string;
    id: string;
  };
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

const publicHttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Public base URL must use http or https.");

const issueEmailVerificationInputSchema = z.object({
  userId: z.string().trim().min(1),
  email: z.email(),
  publicBaseUrl: publicHttpUrlSchema,
  requestId: z.string().trim().min(1),
});

const confirmEmailVerificationChallengeInputSchema = z.object({
  userId: z.string().trim().min(1),
  code: z.string().trim().min(1),
});

const issueIdentityClaimInputSchema = z.object({
  orgId: z.string().trim().min(1, "orgId, actor, and publicBaseUrl are required."),
  actor: z.object({
    scope: z.literal("external"),
    source: z.string().trim().min(1),
    type: z.string().trim().min(1),
    id: z.string().trim().min(1),
  }),
  expiresInMinutes: z
    .number()
    .refine((value) => Number.isFinite(value), {
      message: "expiresInMinutes must be finite.",
    })
    .optional(),
  publicBaseUrl: z.string().trim().min(1, "orgId, actor, and publicBaseUrl are required."),
});

const confirmIdentityClaimInputSchema = z.object({
  externalId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  subjectUserId: z.string().trim().min(1),
});

export const handleEmailVerificationConfirmed = async (
  runtime: BackofficeRuntimeServices,
  payload: OtpConfirmedHookPayload,
) => {
  const verification = emailVerificationPayloadSchema.parse(payload.payload);

  const result = await runtime.objects.auth.singleton().verifyUserEmail({
    userId: payload.externalId,
    expectedEmail: verification.email,
    verifiedAt: payload.confirmedAt,
  });

  if (!result.ok) {
    console.warn("Ignoring email verification OTP that no longer matches an Auth user", {
      otpId: payload.id,
      userId: payload.externalId,
      code: result.code,
    });
  }
};

const handleIdentityClaimConfirmed = async (
  runtime: BackofficeRuntimeServices,
  payload: OtpConfirmedHookPayload,
  context: HookContext,
) => {
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

  await runtime.objects.automations.forOrg(claim.orgId).triggerIngestEvent(
    buildIdentityClaimCompletedAutomationEvent({
      orgId: claim.orgId,
      userId: confirmation.subjectUserId,
      otp: payload,
      claim,
      eventId: context.hookId.toString(),
    }),
    { propagationContext: context.capturePropagationContext() },
  );
};

export class InMemoryOtpObject implements OtpObject {
  readonly #state: BackofficeObjectState;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #host: FragmentDurableObjectHost<void, OtpFragment>;
  #fragment: OtpFragment | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#state = state;
    this.#runtime = runtime;
    this.#host = createFragmentDurableObjectHost({
      name: "OTP",
      state,
      env,
      createRuntime: () =>
        createOtpServer(
          {
            adapters: this.#runtime.adapters,
          },
          {
            hooks: {
              onOtpConfirmed: this.#handleOtpConfirmed.bind(this),
            },
          },
        ),
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

  async #handleOtpConfirmed(payload: OtpConfirmedHookPayload, context: HookContext) {
    switch (payload.type) {
      case EMAIL_VERIFICATION_TYPE: {
        await handleEmailVerificationConfirmed(this.#runtime, payload);
        return;
      }
      case IDENTITY_LINK_TYPE: {
        await handleIdentityClaimConfirmed(this.#runtime, payload, context);
        return;
      }
    }
  }

  #getFragment() {
    if (!this.#fragment) {
      throw new Error("OTP is unavailable.");
    }
    return this.#fragment;
  }

  async issueEmailVerification(
    input: IssueEmailVerificationInput,
  ): Promise<IssueEmailVerificationResult> {
    const parsed = issueEmailVerificationInputSchema.parse(input);
    const requestedPayload = {
      email: parsed.email,
      publicBaseUrl: parsed.publicBaseUrl,
      expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
    };
    const fragment = this.#getFragment();
    const issued = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: parsed.userId,
        type: EMAIL_VERIFICATION_TYPE,
        durationMinutes: EMAIL_VERIFICATION_EXPIRY_MINUTES,
        payload: requestedPayload,
        requestId: parsed.requestId,
      }),
    );
    const persistedPayload = emailVerificationPayloadSchema.parse(issued.payload);

    if (
      persistedPayload.email !== requestedPayload.email ||
      persistedPayload.publicBaseUrl !== requestedPayload.publicBaseUrl ||
      persistedPayload.expiresInHours !== requestedPayload.expiresInHours
    ) {
      throw new Error(
        "Email verification request id cannot be reused with different delivery input.",
      );
    }

    switch (issued.status) {
      case "expired":
        return { deliverable: false, reason: "expired" };
      case "invalidated":
        return { deliverable: false, reason: "superseded" };
      case "confirmed":
        return { deliverable: false, reason: "already_confirmed" };
      case "pending":
        return {
          deliverable: true,
          requestId: issued.id,
          userId: issued.externalId,
          url: buildEmailVerificationUrl(
            persistedPayload.publicBaseUrl,
            issued.externalId,
            issued.code,
          ),
          expiresInHours: persistedPayload.expiresInHours,
          type: EMAIL_VERIFICATION_TYPE,
        };
      default:
        throw new Error("Unsupported OTP status.");
    }
  }

  async confirmEmailVerificationChallenge(
    input: ConfirmEmailVerificationChallengeInput,
  ): Promise<ConfirmEmailVerificationChallengeResult> {
    const parsed = confirmEmailVerificationChallengeInputSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "rejected", reason: "invalid_input" };
    }

    const { userId, code } = parsed.data;
    const fragment = this.#getFragment();
    const confirmation = await fragment.callServices(() =>
      fragment.services.otp.confirmOtp(userId, code, EMAIL_VERIFICATION_TYPE),
    );

    if (!confirmation.confirmed) {
      return {
        status: "rejected",
        reason: confirmation.error === "OTP_EXPIRED" ? "expired" : "invalid",
      };
    }

    return confirmation.status === "confirmation_recorded"
      ? {
          status: "confirmation_recorded",
          requestId: confirmation.requestId,
          userId,
        }
      : { status: "already_confirmed" };
  }

  async issueIdentityClaim(input: IssueIdentityClaimInput): Promise<IssueIdentityClaimResult> {
    const parsed = issueIdentityClaimInputSchema.parse(input);
    const fragment = this.#getFragment();
    const expiresInMinutes =
      typeof parsed.expiresInMinutes === "number"
        ? Math.max(1, Math.floor(parsed.expiresInMinutes))
        : DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES;

    const issued = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: parsed.actor.id,
        type: IDENTITY_LINK_TYPE,
        durationMinutes: expiresInMinutes,
        payload: {
          orgId: parsed.orgId,
          actor: parsed.actor,
        },
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
      return { ok: false, error: confirmation.error };
    }

    return {
      ok: true,
      externalId,
    };
  }

  getDurableHookRepository() {
    return createDurableHookRepository(() => this.#getFragment());
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

export class Otp extends DurableObject<CloudflareEnv> implements OtpObject {
  readonly #object: InMemoryOtpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryOtpObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async issueEmailVerification(
    input: IssueEmailVerificationInput,
  ): Promise<IssueEmailVerificationResult> {
    return await this.#object.issueEmailVerification(input);
  }

  async confirmEmailVerificationChallenge(
    input: ConfirmEmailVerificationChallengeInput,
  ): Promise<ConfirmEmailVerificationChallengeResult> {
    return await this.#object.confirmEmailVerificationChallenge(input);
  }

  async issueIdentityClaim(input: IssueIdentityClaimInput): Promise<IssueIdentityClaimResult> {
    return await this.#object.issueIdentityClaim(input);
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
  ): Promise<ConfirmIdentityClaimResult> {
    return await this.#object.confirmIdentityClaim(input);
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
