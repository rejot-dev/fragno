import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  BACKOFFICE_PI_WORKFLOW_NAME,
  createPiAgentName,
  findPiModelOption,
  resolvePiModelThinkingLevel,
} from "@/fragno/pi/pi-shared";

import type { Route } from "./+types/sessions";
import { createPiSession, fetchPiConfig, sendPiSessionMessage } from "./data";
import type { PiCreateSessionActionData } from "./session-types";

function actionError(message: string): PiCreateSessionActionData {
  return { intent: "create-session", ok: false, message };
}

export async function createSessionAction({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const scope = { kind: "org" as const, orgId: params.orgId };
  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const harnessId = getValue("harnessId");
  const modelOption = getValue("modelOption");
  const prompt = getValue("prompt");

  if (!prompt) {
    return actionError("Write a message to start the session.");
  }
  if (!harnessId) {
    return actionError("Harness selection is required.");
  }
  if (!modelOption) {
    return actionError("Model selection is required.");
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

  const { configState, configError } = await fetchPiConfig(context, scope);
  if (configError) {
    return actionError(configError);
  }
  if (!configState?.configured) {
    return actionError("Pi is not configured yet.");
  }

  const harness = configState.config?.harnesses?.find((entry) => entry.id === harnessId);
  if (!harness) {
    return actionError("Selected harness is unavailable.");
  }
  if (!configState.config?.apiKeys?.[modelSelection.provider]) {
    return actionError(`Missing API key for ${modelSelection.provider}.`);
  }

  const result = await createPiSession(request, context, scope, {
    workflowName: BACKOFFICE_PI_WORKFLOW_NAME,
    metadata: {
      agentName: createPiAgentName({
        harnessId: harness.id,
        provider: modelSelection.provider,
        model: modelSelection.name,
      }),
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
  const detailPath = `/backoffice/sessions/${params.orgId}/sessions/${encodeURIComponent(result.session.workflowName)}/${encodeURIComponent(result.session.id)}`;

  if (messageResult.error) {
    return redirect(`${detailPath}?initialPromptError=${encodeURIComponent(messageResult.error)}`);
  }
  return redirect(detailPath);
}
