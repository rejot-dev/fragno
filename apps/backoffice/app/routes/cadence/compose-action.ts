/*
 * Compose action handler — the server side of compose mode. The prompt posts a
 * `compose` intent with the drafted text. The first prompt starts a Pi agent
 * session and sends the prompt as its first message; subsequent prompts carry the
 * session ref and are sent as follow-ups to that same session. Either way the
 * result is a reference to the session, which the client resolves from the
 * persisted Pi projection to render the live transcript.
 *
 * It mirrors `handlePiTerminalAction` (the dev-terminal handler) so a single
 * route `action` can dispatch both: terminal intents go there, `compose` comes
 * here. The result is discriminated by `intent` so the shared fetcher in
 * `prompt-context` can tell the two apart.
 */

import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  createPiAgentName,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
  resolvePiModelThinkingLevel,
} from "@/fragno/pi/pi-shared";
import {
  createPiSession,
  fetchPiConfig,
  sendPiSessionMessage,
} from "@/routes/backoffice/sessions/data";

/** A reference to the session a prompt started, enough for the client to subscribe. */
export type ComposeSessionRef = {
  id: string;
  workflowName: string;
  agentName: string;
};

export type ComposeActionResult =
  | { intent: "compose"; ok: true; session: ComposeSessionRef }
  | { intent: "compose"; ok: false; error: string };

export async function handleComposeAction({
  formData,
  request,
  context,
  scope,
}: {
  formData: FormData;
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope | null;
}): Promise<ComposeActionResult> {
  const prompt = String(formData.get("prompt") ?? "").trim();

  if (!prompt) {
    return { intent: "compose", ok: false, error: "Describe an automation to compose." };
  }

  if (!scope) {
    return { intent: "compose", ok: false, error: "Select an organisation to compose." };
  }

  // Follow-up to the surface's existing session: the conversation continues, so
  // we just send the prompt as the next message and keep the same session ref.
  const existingSessionId = String(formData.get("sessionId") ?? "").trim();
  const existingWorkflowName = String(formData.get("workflowName") ?? "").trim();
  if (existingSessionId && existingWorkflowName) {
    const followUp = await sendPiSessionMessage(
      request,
      context,
      scope,
      existingWorkflowName,
      existingSessionId,
      { text: prompt },
    );
    if (followUp.error) {
      return { intent: "compose", ok: false, error: followUp.error };
    }
    return {
      intent: "compose",
      ok: true,
      session: {
        id: existingSessionId,
        workflowName: existingWorkflowName,
        agentName: String(formData.get("agentName") ?? "").trim(),
      },
    };
  }

  // No session yet — start one. Pick the org's first configured harness and the
  // first model that has an API key (the same defaults the sessions UI seeds), so
  // exec doesn't need a picker.
  const { configState, configError } = await fetchPiConfig(context, scope);
  if (configError) {
    return { intent: "compose", ok: false, error: configError };
  }
  if (!configState?.configured) {
    return {
      intent: "compose",
      ok: false,
      error: "Pi is not configured yet. Add an API key and a harness in configuration.",
    };
  }

  const harness = resolvePiHarnesses(configState.config?.harnesses)[0];
  const apiKeys = configState.config?.apiKeys;
  const model = PI_MODEL_CATALOG.find((option) => Boolean(apiKeys?.[option.provider]));
  if (!harness || !model) {
    return { intent: "compose", ok: false, error: "Configure an API key to start composing." };
  }

  const agentName = createPiAgentName({
    harnessId: harness.id,
    provider: model.provider,
    model: model.name,
  });

  // Name the session after the prompt so it's recognisable in the sessions list.
  const name = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;

  const created = await createPiSession(request, context, scope, {
    workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
    input: {
      harnessName: agentName,
      thinkingLevel: resolvePiModelThinkingLevel(model.provider),
    },
    name,
  });
  if (created.error || !created.session) {
    return { intent: "compose", ok: false, error: created.error ?? "Failed to start a session." };
  }

  const sent = await sendPiSessionMessage(
    request,
    context,
    scope,
    created.session.workflowName,
    created.session.id,
    { text: prompt },
  );
  if (sent.error) {
    return { intent: "compose", ok: false, error: sent.error };
  }

  return {
    intent: "compose",
    ok: true,
    session: {
      id: created.session.id,
      workflowName: created.session.workflowName,
      agentName: created.session.agent,
    },
  };
}
