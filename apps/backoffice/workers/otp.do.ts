import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
import type { ResolvedOtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
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

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

export type IssueIdentityClaimInput = {
  orgId: string;
  linkSource: string;
  externalActorId: string;
  expiresInMinutes?: number;
  publicBaseUrl: string;
};

export type IssueIdentityClaimResult = {
  ok: true;
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

const emptyQueue = {
  configured: true,
  hooksEnabled: false,
  namespace: null,
  items: [],
  cursor: undefined,
  hasNextPage: false,
} satisfies DurableHookQueueResponse;

export class Otp extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: OtpFragment | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
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

  async #ensureFragment() {
    if (!this.#fragment) {
      this.#fragment = createOtpServer(this.#state, {
        hooks: {
          onOtpConfirmed: this.#handleOtpConfirmed.bind(this),
        },
      });
      this.#migrated = false;
      this.#dispatcher = null;
    }

    if (!this.#migrated) {
      await migrate(this.#fragment);
      this.#migrated = true;
    }

    if (!this.#dispatcher) {
      try {
        const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
          onProcessError: (error) => {
            console.error("OTP hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("OTP hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return this.#fragment;
  }

  async #notifyDispatcher() {
    if (!this.#dispatcher?.notify) {
      return;
    }

    await this.#dispatcher.notify({
      source: "request",
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }

  async issueIdentityClaim(input: IssueIdentityClaimInput): Promise<IssueIdentityClaimResult> {
    const orgId = input.orgId.trim();
    const linkSource = input.linkSource.trim();
    const externalActorId = input.externalActorId.trim();
    const publicBaseUrl = input.publicBaseUrl.trim();

    if (!orgId || !linkSource || !externalActorId || !publicBaseUrl) {
      throw new Error("orgId, linkSource, externalActorId, and publicBaseUrl are required.");
    }

    const fragment = await this.#ensureFragment();
    const expiresInMinutes =
      typeof input.expiresInMinutes === "number" && Number.isFinite(input.expiresInMinutes)
        ? Math.max(1, Math.floor(input.expiresInMinutes))
        : DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES;

    const issued = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.otp.issueOtp(
                externalActorId,
                IDENTITY_LINK_TYPE,
                expiresInMinutes,
                {
                  orgId,
                  linkSource,
                  externalActorId,
                },
              ),
            ] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    await this.#notifyDispatcher();

    return {
      ok: true,
      externalId: issued.externalId,
      code: issued.code,
      url: buildIdentityClaimCompletionUrl(publicBaseUrl, orgId, issued.externalId, issued.code),
      type: IDENTITY_LINK_TYPE,
    };
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
  ): Promise<ConfirmIdentityClaimResult> {
    const externalId = input.externalId.trim();
    const code = input.code.trim();
    const subjectUserId = input.subjectUserId.trim();

    if (!externalId || !code || !subjectUserId) {
      return { ok: false, error: "INVALID_INPUT" };
    }

    const fragment = await this.#ensureFragment();
    const confirmation = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.otp.confirmOtp(externalId, code, IDENTITY_LINK_TYPE, {
                subjectUserId,
              }),
            ] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    if (!confirmation.confirmed) {
      return { ok: false, error: confirmation.error ?? "OTP_INVALID" };
    }

    await this.#notifyDispatcher();

    return {
      ok: true,
      externalId,
    };
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return emptyQueue;
    }

    return await loadDurableHookQueue(fragment, options);
  }

  async alarm(): Promise<void> {
    if (this.#dispatcher?.alarm) {
      await this.#dispatcher.alarm();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse({ message: "OTP is unavailable.", code: "NOT_CONFIGURED" }, 400);
    }

    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
