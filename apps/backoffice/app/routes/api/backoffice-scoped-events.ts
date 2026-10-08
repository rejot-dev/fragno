import { z } from "zod";

import { backofficeContextScopesEqual } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { backofficeScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { createInstalledAppExecution } from "@/fragno/app-installations/authority";
import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
} from "@/fragno/auth/contracts";
import { verifyInstalledAppJwt } from "@/fragno/auth/token-lifecycle";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-scoped-events";

/** Source, actors, and target scope come from the verified credential, never the request body. */
const installedAppEventInputSchema = z.strictObject({
  eventType: z.string().trim().min(1).max(191),
  payload: z.record(z.string(), z.unknown()),
});

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * Accepts an event from an installed app in an organization or project scope.
 *
 * Only app-bound credentials are accepted here, and only for the exact scope they were issued
 * for. Acting for a member, authority is the member's current permissions intersected with the
 * installation's current grants; acting as the installation, only its grants apply. The kernel
 * also requires the scope to be inside the installation's approved resources.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  let scope;
  try {
    scope = backofficeScopeFromSinglePathSegment(params.scopeSegment);
  } catch {
    return jsonResponse({ error: "invalid_request", message: "The scope is invalid." }, 400);
  }
  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!bearer) {
    return jsonResponse(
      {
        error: "authentication_failed",
        message: "An installed-app bearer credential is required.",
      },
      401,
    );
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const verification = await verifyInstalledAppJwt(
    bearer[1],
    request.url,
    runtime.objects.auth.singleton().http,
  );
  if (!verification.ok) {
    return jsonResponse(
      {
        error: "authentication_failed",
        message:
          verification.reason === "expired"
            ? "The installed-app credential has expired."
            : "The installed-app credential is invalid.",
      },
      401,
      verification.reason === "expired"
        ? { [BACKOFFICE_AUTH_ERROR_HEADER]: BACKOFFICE_TOKEN_EXPIRED_CODE }
        : {},
    );
  }
  const credential = verification.payload;
  const credentialScope = credential.scopeRestriction;
  if (!backofficeContextScopesEqual(credentialScope, scope)) {
    return jsonResponse(
      { error: "forbidden", message: "The credential does not permit this scope." },
      403,
    );
  }

  const input = installedAppEventInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return jsonResponse(
      {
        error: "invalid_request",
        message: "The body must contain only an eventType string and a payload object.",
      },
      400,
    );
  }

  if (
    credentialScope.kind === "project" &&
    !(await runtime.objects.automations
      .forOrg(credentialScope.orgId)
      .commands.resolveProjectForExecution({ projectId: credentialScope.projectId }))
  ) {
    return jsonResponse({ error: "not_found", message: "The project is not available." }, 404);
  }

  const execution = createInstalledAppExecution({
    scope: credentialScope,
    actor: credential.actor,
    installation: credential.installation,
  });
  const event: AutomationEvent = {
    id: crypto.randomUUID(),
    scope: credentialScope,
    scopeRestriction: credentialScope,
    source: `app:${credential.installation.appId}`,
    eventType: input.data.eventType,
    occurredAt: new Date().toISOString(),
    payload: input.data.payload,
    actors: execution.actors,
    subject:
      credentialScope.kind === "project"
        ? { orgId: credentialScope.orgId, projectId: credentialScope.projectId }
        : null,
  };
  try {
    const receipt = await kernel.invoke({
      execution,
      operation: BACKOFFICE_PERMISSION.events.emit,
      resource: { kind: "automation-event", source: event.source, eventType: event.eventType },
      execute: async () =>
        await kernel
          .scoped("AUTOMATIONS", credentialScope, runtime.objects.automations)
          .commands.triggerIngestEvent(event),
    });
    // Accepted means durably stored and queued for routing, not that automation has completed.
    return jsonResponse(receipt, 202);
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      return jsonResponse({ error: "forbidden", message: error.message }, 403);
    }
    if (error instanceof Error && error.name === "AutomationEventDefinitionValidationError") {
      return jsonResponse({ error: "invalid_payload", message: error.message }, 422);
    }
    throw error;
  }
}
