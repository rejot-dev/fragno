import type { BackofficeApp } from "@fragno-dev/backoffice-api/v0/apps";
import {
  backofficeProvisioningOperations,
  type BackofficeProvisioningOperationId,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
  type ProvisionProjectInput,
  type ProvisionProjectResult,
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

import { apiError } from "./api-error";

type ProvisioningApp = Pick<
  BackofficeApp,
  "id" | "oauthClientId" | "requestedPermissions" | "actionsRevision"
>;

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

async function provisionProject(
  runtime: BackofficeRuntimeServices,
  app: ProvisioningApp,
  input: ProvisionProjectInput,
): Promise<AppProvisioningResult<ProvisionProjectResult>> {
  const organization = await runtime.objects.auth.singleton().commands.findAppOrganization({
    appId: app.id,
    externalOrganizationId: input.externalOrganizationId,
  });
  if (!organization) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `This app has not provisioned organization '${input.externalOrganizationId}'.`,
      },
    };
  }
  const project = await runtime.objects.automations
    .for({ kind: "org", orgId: organization.organizationId })
    .commands.provisionAppProject({
      appId: app.id,
      externalProjectId: input.externalProjectId,
      name: input.name,
      createdByUserId: organization.createdByUserId,
    });
  return { ok: true, value: { organizationId: organization.organizationId, ...project } };
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
  "users.provision": async (runtime, app, input) => ({
    ok: true,
    value: await runtime.objects.auth
      .singleton()
      .commands.provisionAppUser({ appId: app.id, ...input }),
  }),
  "organizations.provision": provisionOrganization,
  "projects.provision": provisionProject,
  "organizations.members.sync": async (runtime, app, input) =>
    await runtime.objects.auth.singleton().commands.syncAppOrganizationMembers({
      appId: app.id,
      oauthClientId: app.oauthClientId,
      ...input,
    }),
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
  const result = await handle(runtime, app, input.data);
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
  });
  return c.json(output, 200, { "cache-control": "no-store" });
});
