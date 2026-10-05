import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/debug-session-detail";
import { fetchPiManagerSessionDetail } from "./data";

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
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  const me = await requireBackofficeMe(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  const result = await fetchPiManagerSessionDetail(
    request,
    context,
    backofficeRuntimeScopeFromResolvedScope(resolvedScope),
    sessionId,
  );
  if (!result.detail) {
    throw Response.json(result.sessionError, { status: result.status ?? 500 });
  }
  return result.detail;
}

export default function BackofficeOrganizationPiDebugSessionDetail({
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
      <div>
        <p className="text-xs tracking-[0.22em] text-(--bo-muted) uppercase">
          Debug session detail
        </p>
        <h1 className="mt-1 font-mono text-lg text-(--bo-foreground)">
          {loaderData.session.sessionId}
        </h1>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
        <JsonPanel title="Directory session" value={loaderData.session} />
        <JsonPanel title="Conversation view" value={loaderData.view} />
      </div>
    </div>
  );
}
