import { redirect } from "react-router";

import {
  backofficeRouteScopePath,
  requireBackofficeRouteScopeFromParams,
} from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";

import { automationRuntimeScopeFromRouteParams } from "../automations/scope";
import type { Route } from "./+types/sessions";
import { createPiManagerSession, submitPiManagerPrompt } from "./data";
import type { PiCreateSessionActionData } from "./session-types";

function actionError(message: string): PiCreateSessionActionData {
  return { intent: "create-session", ok: false, message };
}

export async function createSessionAction({ request, params, context }: Route.ActionArgs) {
  const me = await requireBackofficeMe(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const scope = automationRuntimeScopeFromRouteParams(
    params,
    me.organizations.map(({ organization }) => organization),
  );
  await requireBackofficeContext(request, context, scope);
  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const modelOption = getValue("modelOption");
  const prompt = getValue("prompt");
  const billingOrganizationId =
    scope.kind === "user" || scope.kind === "system"
      ? (me.activeOrganization?.organization.id ?? null)
      : null;

  if (!prompt) {
    return actionError("Write a message to start the session.");
  }
  if (!modelOption) {
    return actionError("Model selection is required.");
  }
  if (scope.kind === "user" && !billingOrganizationId) {
    return actionError("Select an active organization before starting this session.");
  }

  const [providerRaw, ...modelParts] = modelOption.split("::");
  const modelId = modelParts.join("::");
  if (!providerRaw || !modelId) {
    return actionError("Model selection is invalid.");
  }

  const result = await createPiManagerSession(request, context, scope, {
    name: prompt.split("\n")[0]?.slice(0, 72) || null,
    model: { provider: providerRaw, modelId },
    instructions: "",
    billingOrganizationId,
  });

  if (result.error || !result.session) {
    return actionError(result.error ?? "Failed to create session.");
  }

  const messageResult = await submitPiManagerPrompt(
    request,
    context,
    scope,
    result.session.sessionId,
    {
      requestId: crypto.randomUUID(),
      content: prompt,
      whenBusy: "reject",
    },
  );
  const detailPath = `/backoffice/sessions/${backofficeRouteScopePath(routeScope)}/sessions/${encodeURIComponent(result.session.sessionId)}`;

  if (messageResult.error) {
    return redirect(`${detailPath}?initialPromptError=${encodeURIComponent(messageResult.error)}`);
  }
  return redirect(detailPath);
}
