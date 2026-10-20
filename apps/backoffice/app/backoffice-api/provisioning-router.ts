import type { AppBranding, BackofficeApp } from "@fragno-dev/backoffice-api/v0/apps";
import type { OrganizationMembershipRecord } from "@fragno-dev/backoffice-api/v0/organization";
import {
  type AcceptInvitationInput,
  backofficeProvisioningOperations,
  type BackofficeProvisioningOperationId,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
  type ProvisionProjectInput,
  type ProvisionProjectResult,
  type SendInvitationInput,
  type SendInvitationResult,
} from "@fragno-dev/backoffice-api/v0/provisioning";
import { Hono } from "hono";
import { z } from "zod";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";
import type { AppProvisioningResult } from "@/fragno/auth/app-provisioning";
import {
  PROVISIONING_AUTOMATION_EVENTS,
  PROVISIONING_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/auth";
import { buildAppInvitationEmail } from "@/transactional-emails/app-invitation";

import { apiError } from "./api-error";

type ProvisioningApp = Pick<
  BackofficeApp,
  "id" | "oauthClientId" | "requestedPermissions" | "actionsRevision"
> & { branding: AppBranding };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Creates the organization, then installs the app there with everything it requests and links the
 * installation to the app's organization. Each step is idempotent, so a retry after a failure
 * finishes the ones left. An owner who uninstalled the app decided against it: provisioning does
 * not install it again.
 */
async function provisionOrganization(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  input: ProvisionOrganizationInput,
): Promise<AppProvisioningResult<ProvisionOrganizationResult>> {
  const provisioned = await runtime.objects.auth.singleton().commands.provisionAppOrganization({
    appId: app.id,
    oauthClientId: app.oauthClientId,
    ...input,
  });
  if (!provisioned.ok) {
    return provisioned;
  }
  const installations = runtime.objects.appInstallations.for({
    kind: "org",
    orgId: provisioned.value.organizationId,
  }).commands;
  let installation = await installations.getInstallation({ appId: app.id });
  if (installation?.status === "uninstalled") {
    return {
      ok: false,
      error: {
        code: "conflict",
        message:
          "The organization uninstalled this app; its owners install it again in Backoffice.",
      },
    };
  }
  if (installation === null) {
    requireBackofficeAppOperationValue(
      await installations.installApp({
        appId: app.id,
        grantedPermissions: app.requestedPermissions,
        resourceScope: { kind: "owner" },
        installedByUserId: input.ownerUserId,
        actionsRevision: app.actionsRevision,
      }),
    );
    installation = await installations.getInstallation({ appId: app.id });
  }
  if (installation === null) {
    throw new Error("The provisioned installation could not be read back.");
  }
  const claimed = await installations.claimInstallation({
    appId: app.id,
    activation: installation.activation,
    externalAccount: { id: input.externalOrganizationId, label: input.name },
  });
  if (!claimed.ok) {
    return { ok: false, error: { code: "conflict", message: claimed.error.message } };
  }
  return provisioned;
}

/** Apps reach only organizations where they are installed. */
async function isInstalledIn(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  organizationId: string,
): Promise<boolean> {
  const installation = await runtime.objects.appInstallations
    .for({ kind: "org", orgId: organizationId })
    .commands.getInstallation({ appId: app.id });
  return installation?.status === "active";
}

async function provisionProject(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  input: ProvisionProjectInput,
): Promise<AppProvisioningResult<ProvisionProjectResult>> {
  if (!(await isInstalledIn(runtime, app, input.organizationId))) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `This app is not installed in organization '${input.organizationId}'.`,
      },
    };
  }
  const creator = await runtime.objects.auth.singleton().commands.confirmAppOrganizationMember({
    oauthClientId: app.oauthClientId,
    organizationId: input.organizationId,
    userId: input.createdByUserId,
  });
  if (!creator.ok) {
    return creator;
  }
  const project = await runtime.objects.automations
    .for({ kind: "org", orgId: input.organizationId })
    .commands.provisionAppProject({
      appId: app.id,
      externalProjectId: input.externalProjectId,
      name: input.name,
      createdByUserId: input.createdByUserId,
    });
  return { ok: true, value: { organizationId: input.organizationId, ...project } };
}

function invitationNotFound(invitationId: string): AppProvisioningResult<never> {
  return {
    ok: false,
    error: {
      code: "not_found",
      message: `Invitation '${invitationId}' is not to an organization this app is installed in.`,
    },
  };
}

/** Emails the invitation in the app's name. The link goes to the app, never anywhere else. */
async function sendInvitation(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  input: SendInvitationInput,
): Promise<AppProvisioningResult<SendInvitationResult>> {
  const invitation = await runtime.objects.auth.singleton().commands.findInvitation({
    invitationId: input.invitationId,
  });
  if (invitation === null || !(await isInstalledIn(runtime, app, invitation.organizationId))) {
    return invitationNotFound(input.invitationId);
  }
  const appOrigin = new URL(app.branding.homeUrl).origin;
  if (new URL(input.url).origin !== appOrigin) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: `Invitation links go to the app's own origin, ${appOrigin}.`,
      },
    };
  }
  if (!invitation.pending) {
    return {
      ok: false,
      error: { code: "conflict", message: "The invitation is no longer pending." },
    };
  }
  await runtime.objects.resend.singleton().commands.queueEmail(
    await buildAppInvitationEmail({
      email: invitation.email,
      organizationName: invitation.organizationName,
      inviterName: invitation.inviterName,
      invitationUrl: input.url,
      expiresInDays: Math.max(
        1,
        Math.ceil((Date.parse(invitation.expiresAt) - Date.now()) / DAY_MS),
      ),
      branding: app.branding,
    }),
    // One email per invitation, however often the app asks.
    {
      idempotencyKey: `provisioning:invitation-email:${input.invitationId}`,
      senderName: app.branding.displayName,
    },
  );
  return { ok: true, value: { email: invitation.email } };
}

async function acceptInvitation(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  input: AcceptInvitationInput,
): Promise<AppProvisioningResult<OrganizationMembershipRecord>> {
  const auth = runtime.objects.auth.singleton().commands;
  const invitation = await auth.findInvitation({ invitationId: input.invitationId });
  if (invitation === null || !(await isInstalledIn(runtime, app, invitation.organizationId))) {
    return invitationNotFound(input.invitationId);
  }
  return await auth.acceptAppInvitation({ oauthClientId: app.oauthClientId, ...input });
}

type ProvisioningOperations = typeof backofficeProvisioningOperations;

/** Each operation's implementation; failures the caller can act on come back as values. */
const provisioningHandlers: {
  [TId in BackofficeProvisioningOperationId]: (
    runtime: BackofficeRuntimeServices,
    app: ProvisioningApp,
    input: z.output<ProvisioningOperations[TId]["input"]>,
  ) => Promise<AppProvisioningResult<z.input<ProvisioningOperations[TId]["output"]>>>;
} = {
  "organizations.provision": provisionOrganization,
  "projects.provision": provisionProject,
  "invitations.send": sendInvitation,
  "invitations.accept": acceptInvitation,
};

/**
 * Serves `/api/v0/provisioning/<operationId>` to first-party apps. The app authenticates with its
 * client-credentials token, and each operation requires the provisioning permission of the same
 * name on the app's registration. Every completed operation is recorded as a System event.
 */
export const backofficeProvisioningRouter = new Hono<{
  Bindings: { runtime: BackofficeRuntimeServices };
}>().post("/:operationId", async (c) => {
  const operationId = c.req.param("operationId");
  if (!Object.hasOwn(backofficeProvisioningOperations, operationId)) {
    return apiError("not_found", `Unknown provisioning operation '${operationId}'.`);
  }
  const id = operationId as BackofficeProvisioningOperationId;
  const operation = backofficeProvisioningOperations[id];
  const { runtime } = c.env;

  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(c.req.header("authorization")?.trim() ?? "");
  if (!bearer) {
    return apiError("authentication_failed", "The app's client-credentials token is required.");
  }
  let appId: string;
  try {
    ({ appId } = await runtime.objects.auth.singleton().commands.authenticateInstalledAppClient({
      requestUrl: c.req.url,
      oauthAccessToken: bearer[1],
    }));
  } catch (error) {
    // The error class does not survive Durable Object RPC; its name does.
    if (error instanceof Error && error.name === "BackofficeExecutionTokenAuthenticationError") {
      return apiError("authentication_failed", error.message);
    }
    throw error;
  }
  const app = await runtime.objects.apps.singleton().commands.getApp({ appId });
  if (app?.trust.kind !== "first-party") {
    return apiError("forbidden", "Only apps Backoffice operates may provision.");
  }
  if (!app.trust.provisioningPermissions.includes(operation.permission)) {
    return apiError(
      "forbidden",
      `This app is not granted the '${operation.permission}' provisioning permission.`,
    );
  }

  const body: unknown = await c.req.json().catch(() => undefined);
  const input = operation.input.safeParse(body);
  if (!input.success) {
    return apiError(
      "invalid_request",
      body === undefined ? "The body must be JSON." : z.prettifyError(input.error),
    );
  }
  // The handler was matched to this operation, and `input` was parsed by its schema.
  const handle = provisioningHandlers[id] as (
    runtime: BackofficeRuntimeServices,
    app: ProvisioningApp,
    input: unknown,
  ) => Promise<AppProvisioningResult<unknown>>;
  const result = await handle(runtime, { ...app, branding: app.trust.branding }, input.data);
  if (!result.ok) {
    return apiError(result.error.code, result.error.message);
  }
  const output = operation.output.parse(result.value);

  await runtime.objects.automations.singleton().commands.ingestEvent({
    id: crypto.randomUUID(),
    scopeRestriction: null,
    scope: { kind: "system" },
    source: PROVISIONING_AUTOMATION_SOURCE,
    eventType: PROVISIONING_AUTOMATION_EVENTS[id].eventType,
    occurredAt: new Date().toISOString(),
    payload: { appId: app.id, input: input.data, result: output },
    actors: {
      initiator: { scope: "internal", type: "app", id: app.id, role: "initiator" },
      principal: null,
      delegation: [],
    },
    subject: null,
    causation: { kind: "origin" },
  });
  return c.json(output, 200, { "cache-control": "no-store" });
});
