import type { PiPromptReceipt } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { renderPiAgentPrompt } from "@/fragno/pi/agent/pi-agent-attachments";

import { readPiAgentAttachments } from "./agent-attachments.server";
import { agentModelChoiceFromFormData } from "./agent-model-menu";
import { submitPiManagerPrompt } from "./data";

/** Submits the reader's message from a composer's form: its text, files, and model. */
export async function sendPiAgentMessage({
  request,
  context,
  scope,
  agentName,
  requestId,
  formData,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
  agentName: string;
  requestId: string;
  formData: FormData;
}): Promise<{ ok: true; receipt: PiPromptReceipt } | { ok: false; error: string }> {
  const content = formData.get("content");
  const text = typeof content === "string" ? content.trim() : "";
  const read = await readPiAgentAttachments({
    request,
    context,
    scope,
    agentName,
    field: formData.get("attachments"),
  });
  if ("error" in read) {
    return { ok: false, error: read.error };
  }
  if (!text && read.attachments.length === 0) {
    return { ok: false, error: "Write a message before sending." };
  }

  // Your message joins your own running turn at its next tool boundary; otherwise it waits in the
  // agent's queue for a turn of its own. Sending to a stopped agent resumes its queue.
  const result = await submitPiManagerPrompt(request, context, scope, agentName, {
    requestId,
    content: renderPiAgentPrompt(text, read.attachments),
    whenBusy: "steer",
    whenPaused: "resume",
    model: agentModelChoiceFromFormData(formData),
  });
  return result.error === null
    ? { ok: true, receipt: result.receipt }
    : { ok: false, error: result.error };
}
