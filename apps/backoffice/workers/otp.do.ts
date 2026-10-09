import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { HookContext } from "@fragno-dev/db";
import { otpSchema, type OtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import {
  createBackofficeServiceExecution,
  type BackofficeRequestExecution,
  type BackofficeDeferredExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel, BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type OtpObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { canLinkExternalIdentity } from "@/fragno/automation/external-identities";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import {
  DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
  DEFAULT_SIGN_UP_INVITATION_TTL_DAYS,
  EMAIL_VERIFICATION_EXPIRY_HOURS,
  EMAIL_VERIFICATION_EXPIRY_MINUTES,
  EMAIL_VERIFICATION_TYPE,
  IDENTITY_LINK_TYPE,
  SIGN_UP_INVITATION_TYPE,
  buildEmailVerificationUrl,
  buildIdentityClaimCompletedAutomationEvent,
  buildSignUpInvitationUrl,
  createOtpServer,
  emailVerificationPayloadSchema,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
  signUpInvitationPayloadSchema,
  type OtpFragment,
} from "@/fragno/otp";
import { sha256Hex } from "@/lib/crypto";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

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

export type IssueSignUpInvitationInput = {
  email: string;
  publicBaseUrl: string;
  ttlDays?: number;
};

export type IssueSignUpInvitationResult = {
  invitationId: string;
  email: string;
  url: string;
  ttlDays: number;
  type: typeof SIGN_UP_INVITATION_TYPE;
};

export type ConfirmSignUpInvitationInput = {
  invitationId: string;
  code: string;
  email: string;
};

export type ConfirmSignUpInvitationResult =
  | {
      ok: true;
      invitationId: string;
      email: string;
    }
  | {
      ok: false;
      reason: "invalid_input" | "invalid" | "expired" | "email_mismatch";
    };

/** Issues an identity claim in the OTP object's owning organization. */
export type IssueIdentityClaimInput = {
  expiresInMinutes: number | null;
};

export type IssueIdentityClaimResult = {
  ok: true;
  otpId: string;
  externalId: string;
  code: string;
  type: typeof IDENTITY_LINK_TYPE;
};

export type ConfirmIdentityClaimInput = {
  externalId: string;
  code: string;
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

const signUpInvitationIdEncoder = new TextEncoder();

async function signUpInvitationIdForEmail(email: string): Promise<string> {
  return await sha256Hex(signUpInvitationIdEncoder.encode(`${SIGN_UP_INVITATION_TYPE}:${email}`));
}

const issueSignUpInvitationInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  publicBaseUrl: publicHttpUrlSchema,
  ttlDays: z.number().int().positive().optional(),
});

const confirmSignUpInvitationInputSchema = z.object({
  invitationId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

const issueIdentityClaimInputSchema = z.strictObject({
  expiresInMinutes: z.number().int().positive().nullable(),
});

const confirmIdentityClaimInputSchema = z.strictObject({
  externalId: z.string().trim().min(1),
  code: z.string().trim().min(1),
});

const verifyEmailFromConfirmedOtp = async (
  runtime: BackofficeRuntimeServices,
  input: { otpId: string; userId: string; email: string; verifiedAt: Date },
): Promise<boolean> => {
  const result = await runtime.objects.auth.singleton().commands.verifyUserEmail({
    userId: input.userId,
    expectedEmail: input.email,
    verifiedAt: input.verifiedAt,
  });

  if (!result.ok) {
    console.warn("Ignoring email verification OTP that no longer matches an Auth user", {
      otpId: input.otpId,
      userId: input.userId,
      code: result.code,
    });
  }
  return result.ok;
};

export const handleEmailVerificationConfirmed = async (
  runtime: BackofficeRuntimeServices,
  payload: OtpConfirmedHookPayload,
) => {
  const verification = emailVerificationPayloadSchema.parse(payload.payload);
  await verifyEmailFromConfirmedOtp(runtime, {
    otpId: payload.id,
    userId: payload.externalId,
    email: verification.email,
    verifiedAt: new Date(),
  });
};

/** Processes identity claim completion only within the OTP object's authoritative owner scope. */
export async function handleIdentityClaimConfirmed(
  runtime: BackofficeRuntimeServices,
  ownerScope: BackofficeContextScope,
  payload: OtpConfirmedHookPayload,
  context: HookContext,
) {
  if (ownerScope.kind !== "org") {
    console.warn("Ignoring confirmed identity claim OTP outside an organization scope", {
      otpId: payload.id,
      ownerScope,
    });
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
  if (claim.orgId !== ownerScope.orgId) {
    // A persisted claim can predate the public API restriction. Never grant its payload authority
    // to target a different organization, and do not retry a permanently invalid claim.
    console.warn("Ignoring confirmed identity claim OTP with mismatched organization", {
      otpId: payload.id,
      claimOrgId: claim.orgId,
      ownerOrgId: ownerScope.orgId,
    });
    return;
  }

  const confirmation = confirmationResult.data;
  const automations = runtime.objects.automations.for(ownerScope);
  const propagationContext = context.capturePropagationContext();

  const bindingResult = await automations.commands.bindExternalIdentity(
    {
      identity: claim.actor,
      userId: confirmation.subjectUserId,
      verifiedByClaimId: payload.id,
    },
    {
      execution: createBackofficeServiceExecution({
        scope: ownerScope,
        service: { type: "object", id: "otp" },
      }),
      propagationContext,
    },
  );

  if (bindingResult.status !== "active") {
    return;
  }

  await automations.commands.triggerIngestEvent(
    buildIdentityClaimCompletedAutomationEvent({
      orgId: ownerScope.orgId,
      userId: confirmation.subjectUserId,
      otp: payload,
      claim,
      eventId: context.hookId.toString(),
    }),
    { propagationContext },
  );
}

export class InMemoryOtpObject implements OtpObject {
  readonly #runtime: BackofficeRuntimeServices;
  readonly #ownerScope: BackofficeContextScope;
  readonly #host: FragmentDurableObjectHost<void, OtpFragment>;
  #fragment: OtpFragment | null = null;

  constructor({
    state,
    runtime,
    implementation,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    this.#runtime = runtime;
    this.#ownerScope = requireBackofficeContextScopeFromDurableObjectId(state.id, "OTP");
    this.#host = implementation.createFragmentHost({
      name: "OTP",
      createRuntime: () =>
        createOtpServer(implementation.fragmentDatabase, {
          hooks: {
            onOtpConfirmed: this.#handleOtpConfirmed.bind(this),
          },
        }),
      onProcessError: (error) => {
        console.error("OTP hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("OTP hook dispatcher initialization failed", error);
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
        await handleIdentityClaimConfirmed(this.#runtime, this.#ownerScope, payload, context);
        return;
      }
      case SIGN_UP_INVITATION_TYPE: {
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

  #requireIdentityClaimScope(): Extract<BackofficeContextScope, { kind: "org" }> {
    if (this.#ownerScope.kind !== "org") {
      throw new Error("Identity claims require an organization-scoped OTP object.");
    }
    return this.#ownerScope;
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

    // Idempotent issuance by request ID returns the persisted confirmed OTP. Recover the trusted
    // email from that record instead of accepting an email address from the confirmation request.
    const confirmedOtp = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: userId,
        type: EMAIL_VERIFICATION_TYPE,
        requestId: confirmation.requestId,
      }),
    );
    const verification = emailVerificationPayloadSchema.parse(confirmedOtp.payload);
    const verified = await verifyEmailFromConfirmedOtp(this.#runtime, {
      otpId: confirmation.requestId,
      userId,
      email: verification.email,
      verifiedAt: new Date(),
    });
    if (!verified) {
      return { status: "rejected", reason: "invalid" };
    }

    return confirmation.status === "confirmation_recorded"
      ? {
          status: "confirmation_recorded",
          requestId: confirmation.requestId,
          userId,
        }
      : { status: "already_confirmed" };
  }

  async issueSignUpInvitation(
    input: IssueSignUpInvitationInput,
  ): Promise<IssueSignUpInvitationResult> {
    const parsed = issueSignUpInvitationInputSchema.parse(input);
    const invitationId = await signUpInvitationIdForEmail(parsed.email);
    const ttlDays = parsed.ttlDays ?? DEFAULT_SIGN_UP_INVITATION_TTL_DAYS;
    const payload = {
      email: parsed.email,
      publicBaseUrl: parsed.publicBaseUrl,
      ttlDays,
    };
    const fragment = this.#getFragment();
    const issued = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: invitationId,
        type: SIGN_UP_INVITATION_TYPE,
        durationMinutes: ttlDays * 24 * 60,
        payload,
      }),
    );

    return {
      invitationId,
      email: payload.email,
      url: buildSignUpInvitationUrl(payload.publicBaseUrl, invitationId, issued.code),
      ttlDays,
      type: SIGN_UP_INVITATION_TYPE,
    };
  }

  async confirmSignUpInvitation(
    input: ConfirmSignUpInvitationInput,
  ): Promise<ConfirmSignUpInvitationResult> {
    const parsed = confirmSignUpInvitationInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_input" };
    }

    const { invitationId, code, email } = parsed.data;
    const fragment = this.#getFragment();
    const confirmation = await fragment.callServices(() =>
      fragment.services.otp.confirmOtp(invitationId, code, SIGN_UP_INVITATION_TYPE),
    );
    if (!confirmation.confirmed) {
      return {
        ok: false,
        reason: confirmation.error === "OTP_EXPIRED" ? "expired" : "invalid",
      };
    }

    // Repeated confirmation is valid for retries, so recover the invitation's trusted email from
    // the persisted issuance payload instead of accepting it from the sign-up request.
    const confirmedOtp = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: invitationId,
        type: SIGN_UP_INVITATION_TYPE,
        requestId: confirmation.requestId,
      }),
    );
    const invitation = signUpInvitationPayloadSchema.parse(confirmedOtp.payload);
    if (invitation.email !== email) {
      return { ok: false, reason: "email_mismatch" };
    }

    return { ok: true, invitationId, email: invitation.email };
  }

  async issueIdentityClaim(
    input: IssueIdentityClaimInput,
    execution: BackofficeDeferredExecution,
  ): Promise<IssueIdentityClaimResult> {
    const ownerScope = this.#requireIdentityClaimScope();
    if (
      execution.kind !== "deferred" ||
      !backofficeContextScopesEqual(execution.scope, ownerScope) ||
      execution.actors.initiator.scope !== "external"
    ) {
      throw new BackofficeForbiddenError(
        "Identity issuance requires trusted external ingress in the owning organization.",
      );
    }
    const initiator = execution.actors.initiator;
    if (!canLinkExternalIdentity(initiator)) {
      throw new BackofficeForbiddenError("This external identity cannot be linked to a user.");
    }
    const actor = {
      scope: "external" as const,
      source: initiator.source,
      type: initiator.type,
      id: initiator.id,
    };
    const parsed = issueIdentityClaimInputSchema.parse(input);
    const fragment = this.#getFragment();
    const expiresInMinutes = parsed.expiresInMinutes ?? DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES;

    const issued = await fragment.callServices(() =>
      fragment.services.otp.issueOtp({
        externalId: actor.id,
        type: IDENTITY_LINK_TYPE,
        durationMinutes: expiresInMinutes,
        payload: {
          orgId: ownerScope.orgId,
          actor,
        },
      }),
    );

    return {
      ok: true,
      otpId: issued.id,
      externalId: issued.externalId,
      code: issued.code,
      type: IDENTITY_LINK_TYPE,
    };
  }

  async getIdentityClaim(input: ConfirmIdentityClaimInput) {
    const ownerScope = this.#requireIdentityClaimScope();
    const parsed = confirmIdentityClaimInputSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    const { externalId, code } = parsed.data;
    const claim = await this.#getFragment().inContext(async function () {
      return await this.handlerTx()
        .retrieve((uow) =>
          uow
            .forSchema(otpSchema)
            .findFirst("otp", (b) =>
              b.whereIndex("idx_otp_externalId_type_status_code_expiresAt", (eb) =>
                eb.and(
                  eb("externalId", "=", externalId),
                  eb("type", "=", IDENTITY_LINK_TYPE),
                  eb("status", "=", "pending"),
                  eb("code", "=", code.trim().toUpperCase()),
                  eb("expiresAt", ">", eb.now()),
                ),
              ),
            ),
        )
        .transform(({ retrieveResult: [otp] }) =>
          otp ? identityClaimPayloadSchema.parse(otp.payload) : null,
        )
        .execute();
    });
    return claim?.orgId === ownerScope.orgId ? { actor: claim.actor } : null;
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
    execution: BackofficeRequestExecution,
  ): Promise<ConfirmIdentityClaimResult> {
    const ownerScope = this.#requireIdentityClaimScope();
    if (
      execution.kind !== "request" ||
      !backofficeContextScopesEqual(execution.scope, ownerScope)
    ) {
      throw new BackofficeForbiddenError(
        "Identity confirmation requires authenticated execution in the owning organization.",
      );
    }
    await new BackofficeKernel(this.#runtime).assertAuthorized({
      execution,
      operation: BACKOFFICE_PERMISSION.identity.link,
    });
    const parsed = confirmIdentityClaimInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "INVALID_INPUT" };
    }

    const { externalId, code } = parsed.data;
    const subjectUserId = execution.actors.principal.id;
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

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

export class Otp extends DurableObject<CloudflareEnv> implements OtpObject {
  readonly #object: InMemoryOtpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryOtpObject(createCloudflareBackofficeObjectContext(state, env));
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

  async issueSignUpInvitation(
    input: IssueSignUpInvitationInput,
  ): Promise<IssueSignUpInvitationResult> {
    return await this.#object.issueSignUpInvitation(input);
  }

  async confirmSignUpInvitation(
    input: ConfirmSignUpInvitationInput,
  ): Promise<ConfirmSignUpInvitationResult> {
    return await this.#object.confirmSignUpInvitation(input);
  }

  async issueIdentityClaim(
    input: IssueIdentityClaimInput,
    execution: BackofficeDeferredExecution,
  ): Promise<IssueIdentityClaimResult> {
    return await this.#object.issueIdentityClaim(input, execution);
  }

  async getIdentityClaim(input: ConfirmIdentityClaimInput) {
    return await this.#object.getIdentityClaim(input);
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
    execution: BackofficeRequestExecution,
  ): Promise<ConfirmIdentityClaimResult> {
    return await this.#object.confirmIdentityClaim(input, execution);
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#object.getDurableHookQueue(options);
  }

  async getDurableHook(hookId: string) {
    return await this.#object.getDurableHook(hookId);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
