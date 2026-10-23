import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-compactions";
import { compactPiManagerAgent } from "./data";

/** Starts a manual Pi compaction; its task is then read from `compactions/:taskId`. */
export async function action({ request, params, context }: Route.ActionArgs) {
  const instructions = (await request.formData()).get("instructions");
  const result = await compactPiManagerAgent(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    typeof instructions === "string" && instructions.trim() ? instructions.trim() : null,
  );
  return result.error || !result.taskId
    ? { ok: false as const, error: result.error ?? "Failed to compact the conversation." }
    : { ok: true as const, taskId: result.taskId };
}
