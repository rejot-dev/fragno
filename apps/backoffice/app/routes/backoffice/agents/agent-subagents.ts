import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/agent-subagents";
import { fetchPiManagerSubagents, type PiManagerSubagentList } from "./data";

type ManagerSubagent = PiManagerSubagentList["subagents"][number];

/**
 * Who asked for a subagent, as the agent's page shows it: its agent's own turn, from a tool call it
 * shows the subagent under, or someone else, by name; null names no one, such as a person.
 */
export type AgentSubagentAsker =
  | { kind: "turn"; toolCallId: string }
  | { kind: "other"; name: string | null };

export type AgentSubagent = Omit<ManagerSubagent, "askedBy"> & { askedBy: AgentSubagentAsker };

/** Lists the agent's latest subagents, newest first, naming who asked for each. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { subagents } = await fetchPiManagerSubagents(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
  const { runtime } = context.get(BackofficeWorkerContext);
  const appIds = new Set(
    subagents.flatMap(({ askedBy }) => (askedBy.kind === "app" ? [askedBy.appId] : [])),
  );
  const appSlugs = new Map(
    await Promise.all(
      [...appIds].map(
        async (appId) =>
          [
            appId,
            (await runtime.objects.apps.singleton().commands.getApp({ appId }))?.slug ?? null,
          ] as const,
      ),
    ),
  );
  function asker(askedBy: ManagerSubagent["askedBy"]): AgentSubagentAsker {
    switch (askedBy.kind) {
      case "turn":
        return askedBy;
      case "agent":
        return { kind: "other", name: formatPiAgentName(askedBy.agentName) };
      case "app": {
        const slug = appSlugs.get(askedBy.appId) ?? null;
        return { kind: "other", name: slug === null ? null : capitalize(slug) };
      }
      case "person":
        return { kind: "other", name: null };
    }
    throw new Error("Unsupported subagent asker.", { cause: askedBy satisfies never });
  }
  return {
    subagents: subagents.map(
      (subagent): AgentSubagent => ({ ...subagent, askedBy: asker(subagent.askedBy) }),
    ),
  };
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
