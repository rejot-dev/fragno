import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { ResolvedOtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import type { OtpObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { createDurableHookRepository } from "@/fragno/durable-hooks";
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

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

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

  async #handleOtpConfirmed(payload: ResolvedOtpConfirmedHookPayload, context: { hookId: string }) {
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

    await this.#runtime.objects.automations.forOrg(claim.orgId).triggerIngestEvent(
      buildIdentityClaimCompletedAutomationEvent({
        orgId: claim.orgId,
        userId: confirmation.subjectUserId,
        otp: payload,
        claim,
        eventId: context.hookId,
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
      fragment.services.otp.issueOtp(parsed.actor.id, IDENTITY_LINK_TYPE, expiresInMinutes, {
        orgId: parsed.orgId,
        actor: parsed.actor,
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
