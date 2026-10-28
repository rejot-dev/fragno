import { z } from "zod";

import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-messages";
import { sendPiAgentMessage } from "./agent-message.server";

/** Sends the reader's message to a provisioned agent; its view stream then shows it. */
export async function action({ request, params, context }: Route.ActionArgs) {
  const formData = await request.formData();
  // The conversation names its messages, so it recognizes them in the agent's queue.
  const requestId = z.uuid().safeParse(formData.get("requestId")).data;
  if (requestId === undefined) {
    return { ok: false as const, error: "A message's request ID must be a UUID." };
  }
  return await sendPiAgentMessage({
    request,
    context,
    scope: requireRouteScope(context).execution.scope,
    agentName: params.agentName,
    requestId,
    formData,
  });
}
