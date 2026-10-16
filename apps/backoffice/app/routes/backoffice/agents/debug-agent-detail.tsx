import {} from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/debug-agent-detail";
import { formatPiAgentName } from "./agent-name";
import { fetchPiManagerAgentDetail } from "./data";

const stringifyJson = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, current: unknown): unknown => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }
      if (typeof current === "bigint") {
        return current.toString();
      }
      return current;
    },
    2,
  );

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="min-h-0 border border-(--bo-border) bg-(--bo-panel)">
      <div className="border-b border-(--bo-border) px-4 py-3">
        <h2 className="text-xs tracking-[0.22em] text-(--bo-muted) uppercase">{title}</h2>
      </div>
      <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-(--bo-foreground)">
        {stringifyJson(value)}
      </pre>
    </section>
  );
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const result = await fetchPiManagerAgentDetail(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
  if (!result.detail) {
    throw Response.json(result.agentError, { status: result.status ?? 500 });
  }
  return result.detail;
}

export default function BackofficeOrganizationPiDebugAgentDetail({
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
      <div>
        <p className="text-xs tracking-[0.22em] text-(--bo-muted) uppercase">Debug agent detail</p>
        <h1 className="mt-1 text-lg text-(--bo-foreground)">
          {formatPiAgentName(loaderData.agent.agentName)}
        </h1>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
        <JsonPanel title="Directory agent" value={loaderData.agent} />
        <JsonPanel title="Conversation view" value={loaderData.view} />
      </div>
    </div>
  );
}
