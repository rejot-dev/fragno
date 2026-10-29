import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { z } from "zod";

import { decodeCursor, type Cursor, type HookContext } from "@fragno-dev/db";
import { otpSchema, type OtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import type { BackofficeHostTelemetry } from "@/backoffice-runtime/backoffice-telemetry";
import {
  createBackofficeServiceExecution,
  type BackofficeRequestExecution,
  type BackofficeDeferredExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel, BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type OtpCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { generateAccessCode, normalizeAccessCode } from "@/fragno/access-codes/access-code";
import {
  ACCESS_CODE_MAX_PAGE_SIZE,
  accessCodeInputSchema,
  accessCodePageInputSchema,
  accessCodeRedemptionsInputSchema,
  createAccessCodeInputSchema,
  redeemAccessCodeInputSchema,
  revokeAccessCodeInputSchema,
  type AccessCodeCheck,
  type AccessCodePageInput,
  type AccessCodePageResult,
  type AccessCodeRecord,
  type AccessCodeRedemptionsInput,
  type AccessCodeRedemptionsResult,
  type CreateAccessCodeInput,
  type CreateAccessCodeResult,
  type RedeemAccessCodeInput,
  type RevokeAccessCodeInput,
} from "@/fragno/access-codes/contracts";
import {
  ACCESS_CODE_ORDER_INDEX,
  ACCESS_CODE_REDEMPTION_ORDER_INDEX,
} from "@/fragno/access-codes/schema";
import { createAccessCodesServer, type AccessCodesFragment } from "@/fragno/access-codes/server";
import { canLinkExternalIdentity } from "@/fragno/automation/external-identities";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import {
  DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
  EMAIL_VERIFICATION_EXPIRY_HOURS,
  EMAIL_VERIFICATION_EXPIRY_MINUTES,
  EMAIL_VERIFICATION_TYPE,
  IDENTITY_LINK_TYPE,
  buildEmailVerificationUrl,
  buildIdentityClaimCompletedAutomationEvent,
  createOtpServer,
  emailVerificationPayloadSchema,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
  type OtpFragment,
} from "@/fragno/otp";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

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
      organization: ownerScope,
      userId: confirmation.subjectUserId,
      otp: payload,
      claim,
      eventId: context.hookId.toString(),
    }),
    { propagationContext },
  );
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Null for anything but a cursor from a previous page of access codes. */
function decodeAccessCodeCursor(encoded: string, indexName: string): Cursor | null {
  let cursor: Cursor;
  try {
    cursor = decodeCursor(encoded);
  } catch {
    return null;
  }
  return cursor.indexName === indexName &&
    cursor.orderDirection === "desc" &&
    cursor.pageSize >= 1 &&
    cursor.pageSize <= ACCESS_CODE_MAX_PAGE_SIZE
    ? cursor
    : null;
}

type OtpRuntime = { otp: OtpFragment; accessCodes: AccessCodesFragment };

export class OtpObject implements OtpCommands {
  readonly #runtime: BackofficeRuntimeServices;
  readonly #ownerScope: BackofficeContextScope;
  readonly #nowEpochMs: () => number;
  readonly #telemetry: BackofficeHostTelemetry;
  readonly #host: FragmentDurableObjectHost<void, OtpRuntime>;
  #fragments: OtpRuntime | null = null;

  constructor({
    state,
    runtime,
    implementation,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    nowEpochMs: () => number;
  }) {
    this.#runtime = runtime;
    this.#ownerScope = requireBackofficeContextScopeFromDurableObjectId(state.id, "OTP");
    this.#nowEpochMs = nowEpochMs;
    this.#telemetry = implementation.hostTelemetry("OTP");
    this.#host = implementation.createFragmentHost({
      name: "OTP",
      createRuntime: (): OtpRuntime => {
        const { adapters, transactionInstrumentation } = implementation.fragmentDatabase;
        const databaseAdapter = adapters.createAdapter({ kind: "otp" });
        return {
          otp: createOtpServer(databaseAdapter, {
            hooks: {
              onOtpConfirmed: this.#handleOtpConfirmed.bind(this),
            },
          }),
          // Organization OTP objects keep an empty table; only the singleton admits accounts.
          accessCodes: createAccessCodesServer({ databaseAdapter, transactionInstrumentation }),
        };
      },
      getMigrationFragments: (fragments) => [fragments.otp, fragments.accessCodes],
      hostRuntime: (fragments, { hostFragment }) => ({
        ...fragments,
        otp: hostFragment(fragments.otp),
      }),
      mounts: [{ id: "otp", target: (fragments) => fragments.otp }],
      onProcessError: (error) => {
        console.error("OTP hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("OTP hook dispatcher initialization failed", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragments = await this.#host.initialize(undefined);
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
    }
  }

  #requireFragments(): OtpRuntime {
    if (!this.#fragments) {
      throw new Error("OTP is unavailable.");
    }
    return this.#fragments;
  }

  #getFragment(): OtpFragment {
    return this.#requireFragments().otp;
  }

  #getAccessCodesFragment(): AccessCodesFragment {
    if (this.#ownerScope.kind !== "system") {
      throw new Error("Access codes require the singleton OTP object.");
    }
    return this.#requireFragments().accessCodes;
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

  async createAccessCode(input: CreateAccessCodeInput): Promise<CreateAccessCodeResult> {
    const { label, codeSource, expiresInDays } = createAccessCodeInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    const code = codeSource === "label" ? normalizeAccessCode(label) : generateAccessCode();
    return await fragment.callServices(() =>
      fragment.services.createAccessCode({
        code,
        label,
        expiresAt: expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * DAY_MS),
        now,
      }),
    );
  }

  async listAccessCodes(input: AccessCodePageInput): Promise<AccessCodePageResult> {
    const page = accessCodePageInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    if (page.page === "first") {
      return {
        ok: true,
        page: await fragment.callServices(() =>
          fragment.services.listAccessCodes({ ...page, now }),
        ),
      };
    }
    const cursor = decodeAccessCodeCursor(page.cursor, ACCESS_CODE_ORDER_INDEX);
    if (cursor === null) {
      return { ok: false, reason: "cursor_invalid" };
    }
    return {
      ok: true,
      page: await fragment.callServices(() =>
        fragment.services.listAccessCodes({ page: "next", cursor, now }),
      ),
    };
  }

  async revokeAccessCode(input: RevokeAccessCodeInput): Promise<AccessCodeRecord | null> {
    const { accessCodeId } = revokeAccessCodeInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    return await fragment.callServices(() =>
      fragment.services.revokeAccessCode({ accessCodeId, now }),
    );
  }

  async checkAccessCode(input: { code: string }): Promise<AccessCodeCheck> {
    const { code } = accessCodeInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    return await fragment.callServices(() => fragment.services.checkAccessCode({ code, now }));
  }

  async redeemAccessCode(input: RedeemAccessCodeInput): Promise<AccessCodeCheck> {
    const { code, email } = redeemAccessCodeInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    const redemption = await fragment.callServices(() =>
      fragment.services.redeemAccessCode({ code, email, now }),
    );
    if (!redemption.ok) {
      return redemption;
    }
    if (redemption.redemption === "new") {
      this.#telemetry.record({
        kind: "access-code-redeemed",
        accessCodeId: redemption.accessCode.id,
        accessCodeLabel: redemption.accessCode.label,
      });
    }
    return { ok: true };
  }

  async listAccessCodeRedemptions(
    input: AccessCodeRedemptionsInput,
  ): Promise<AccessCodeRedemptionsResult> {
    const { code, pagination } = accessCodeRedemptionsInputSchema.parse(input);
    const fragment = this.#getAccessCodesFragment();
    const now = new Date(this.#nowEpochMs());
    if (pagination.page === "first") {
      return await fragment.callServices(() =>
        fragment.services.listAccessCodeRedemptions({ code, page: pagination, now }),
      );
    }
    const cursor = decodeAccessCodeCursor(pagination.cursor, ACCESS_CODE_REDEMPTION_ORDER_INDEX);
    if (cursor === null) {
      return { ok: false, reason: "cursor_invalid" };
    }
    return await fragment.callServices(() =>
      fragment.services.listAccessCodeRedemptions({
        code,
        page: { page: "next", cursor },
        now,
      }),
    );
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#requireFragments(), request);
  }
}
