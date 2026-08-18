import { redirect } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  BACKOFFICE_PI_WORKFLOW_NAME,
  PI_BILLING_ORGANIZATION_ID_METADATA_KEY,
  findPiModelOption,
  resolvePiModelThinkingLevel,
} from "@/fragno/pi/pi-shared";

import { automationScopeFromRouteParams } from "../automations/scope";
import type { Route } from "./+types/sessions";
import { createPiSession, fetchPiRuntimeState, sendPiSessionMessage } from "./data";
import type { PiCreateSessionActionData } from "./session-types";

function actionError(message: string): PiCreateSessionActionData {
  return { intent: "create-session", ok: false, message };
}

export async function createSessionAction({ request, params, context }: Route.ActionArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);
  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const modelOption = getValue("modelOption");
  const prompt = getValue("prompt");
  const billingOrganizationId =
    scope.kind === "user"
      ? ((await getAuthMe(request, context))?.activeOrganization?.organization.id ?? null)
      : null;

  if (!prompt) {
    return actionError("Write a message to start the session.");
  }
  if (!modelOption) {
    return actionError("Model selection is required.");
  }
  if (scope.kind === "user" && !billingOrganizationId) {
    return actionError("Select an active organization before starting a personal session.");
  }

  const [providerRaw, ...modelParts] = modelOption.split("::");
  const model = modelParts.join("::");
  if (!providerRaw || !model) {
    return actionError("Model selection is invalid.");
  }

  const modelSelection = findPiModelOption(providerRaw as "openai" | "anthropic" | "gemini", model);
  if (!modelSelection) {
    return actionError("Model selection is invalid.");
  }

  const { runtimeState, runtimeError } = await fetchPiRuntimeState(context, scope);
  if (runtimeError) {
    return actionError(runtimeError);
  }
  if (
    !runtimeState?.modelCatalog.some(
      (option) =>
        option.provider === modelSelection.provider && option.name === modelSelection.name,
    )
  ) {
    return actionError(`Missing API key for ${modelSelection.provider}.`);
  }

  const result = await createPiSession(request, context, scope, {
    workflowName: BACKOFFICE_PI_WORKFLOW_NAME,
    metadata: {
      model: { provider: modelSelection.provider, name: modelSelection.name },
      ...(billingOrganizationId
        ? { [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: billingOrganizationId }
        : {}),
    },
    input: {
      thinkingLevel: resolvePiModelThinkingLevel(modelSelection.provider),
    },
    name: prompt.split("\n")[0]?.slice(0, 72) || undefined,
  });

  if (result.error || !result.session) {
    return actionError(result.error ?? "Failed to create session.");
  }

  const messageResult = await sendPiSessionMessage(
    request,
    context,
    scope,
    result.session.workflowName,
    result.session.id,
    { text: prompt, commandKind: "prompt" },
  );
  const detailPath = `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions/${encodeURIComponent(result.session.workflowName)}/${encodeURIComponent(result.session.id)}`;

  if (messageResult.error) {
    return redirect(`${detailPath}?initialPromptError=${encodeURIComponent(messageResult.error)}`);
  }
  return redirect(detailPath);
}
