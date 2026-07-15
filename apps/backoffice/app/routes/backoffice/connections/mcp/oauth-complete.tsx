import { Link, useLoaderData, useOutletContext } from "react-router";

import type { Route } from "./+types/oauth-complete";
import type { McpLayoutContext } from "./shared";

type McpOAuthCompleteLoaderData = {
  serverSlug: string | null;
  status: "success" | "error";
};

export function loader({ url }: Route.LoaderArgs) {
  const status = url.searchParams.get("status") === "success" ? "success" : "error";
  const serverSlug = url.searchParams.get("server")?.trim() || null;

  return { serverSlug, status } satisfies McpOAuthCompleteLoaderData;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.status === "error" ? "MCP OAuth failed" : "MCP OAuth connected" }];
}

export default function BackofficeOrganisationMcpOAuthComplete() {
  const { orgId, organisation } = useOutletContext<McpLayoutContext>();
  const { serverSlug, status } = useLoaderData<typeof loader>();
  const isSuccess = status === "success";

  return (
    <section className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="border-b border-[color:var(--bo-border)] bg-[radial-gradient(circle_at_top_left,var(--bo-accent-bg),transparent_42%)] p-6">
        <div
          className={`inline-flex h-12 w-12 items-center justify-center rounded-full border text-2xl ${
            isSuccess
              ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
              : "border-red-500/40 bg-red-500/10 text-red-500"
          }`}
          aria-hidden="true"
        >
          {isSuccess ? "✓" : "!"}
        </div>
        <p className="mt-5 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          MCP OAuth
        </p>
        <h1 className="mt-2 max-w-2xl text-2xl font-semibold [text-wrap:balance] text-[var(--bo-fg)]">
          {isSuccess ? "Authentication complete" : "Authentication could not be completed"}
        </h1>
        <p className="mt-3 max-w-2xl text-sm [text-wrap:pretty] text-[var(--bo-muted)]">
          {isSuccess
            ? `Backoffice has saved the OAuth credentials${
                serverSlug ? ` for ${serverSlug}` : ""
              } in ${organisation.name}'s MCP connection.`
            : "Backoffice received the OAuth callback, but the MCP fragment did not confirm authentication."}
        </p>
      </div>

      <div className="grid gap-3 p-4 text-sm text-[var(--bo-muted)] md:grid-cols-2">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Organisation
          </p>
          <p className="mt-2 text-[var(--bo-fg)]">{organisation.name}</p>
        </div>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Server</p>
          <p className="mt-2 text-[var(--bo-fg)]">{serverSlug ?? "MCP server"}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[color:var(--bo-border)] p-4">
        <Link
          to={`/backoffice/connections/mcp/${orgId}/configuration`}
          className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
        >
          Back to MCP configuration
        </Link>
        <Link
          to="/backoffice/connections/mcp"
          className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:text-[var(--bo-fg)]"
        >
          View MCP organisations
        </Link>
      </div>
    </section>
  );
}
