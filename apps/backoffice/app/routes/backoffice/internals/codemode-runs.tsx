import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Link, Outlet, useLoaderData, useParams } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/codemode-runs";
import { internalsScopeBasePath } from "./internals-scope";
import { formatTimestamp, getStepStatusBadgeClasses } from "./workflows-shared";

const RUNS_PAGE_SIZE = 20;

export async function loader({ context, url }: Route.LoaderArgs) {
  const { resolvedScope, execution } = requireRouteScope(context);
  const codemode = getBackofficeObjects(context).codemode.for(execution.scope).commands;
  const cursor = url.searchParams.get("runsCursor");
  let page;
  try {
    page = await codemode.listRuns(
      cursor === null ? { page: "first", pageSize: RUNS_PAGE_SIZE } : { page: "next", cursor },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CODEMODE_RUN_CURSOR_INVALID")) {
      throw new Response("Invalid runs cursor.", { status: 400 });
    }
    throw error;
  }
  return {
    internalsBasePath: internalsScopeBasePath(backofficeRouteScopeFromResolvedScope(resolvedScope)),
    scopeLabel: backofficeContextScopeLabel(execution.scope),
    runs: page.runs.map((run) => ({
      id: run.id,
      status: run.status,
      activationKind: run.activationKind,
      origin: run.origin.kind === "file" ? run.origin.path : "inline",
      createdAt: run.createdAt,
    })),
    nextCursor: page.hasNextPage ? page.cursor : null,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Codemode runs · ${loaderData?.scopeLabel ?? "scope"}` }];
}

export default function BackofficeCodemodeRuns() {
  const { internalsBasePath, scopeLabel, runs, nextCursor } = useLoaderData<typeof loader>();
  const { runId: selectedRunId } = useParams();
  const runsPath = `${internalsBasePath}/codemode`;

  return (
    <div className="min-w-0 space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: internalsBasePath },
          { label: "Codemode runs" },
        ]}
        eyebrow="Internals"
        title={`Codemode runs · ${scopeLabel}`}
        description="Every run in the selected scope, newest first. Runs and their tool calls are kept for 7 days."
      />

      <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <div
          className={`${selectedRunId ? "hidden lg:block" : "block"} min-w-0 space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          {runs.length === 0 ? (
            <p className="text-sm text-[var(--bo-muted)]">No codemode runs in this scope.</p>
          ) : (
            runs.map((run) => {
              const isSelected = run.id === selectedRunId;
              return (
                <Link
                  key={run.id}
                  to={`${runsPath}/${encodeURIComponent(run.id)}`}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    isSelected
                      ? "block border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] p-3 text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)]"
                      : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  }
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <p className="truncate font-semibold text-[var(--bo-fg)]" title={run.origin}>
                      {run.origin}
                    </p>
                    <span
                      className={`shrink-0 border px-2 py-1 text-[9px] tracking-[0.16em] uppercase ${getStepStatusBadgeClasses(run.status)}`}
                    >
                      {run.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
                    {run.activationKind} · {run.id}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--bo-muted-2)]">
                    {formatTimestamp(run.createdAt)}
                  </p>
                </Link>
              );
            })
          )}
          {nextCursor ? (
            <div className="pt-2">
              <ButtonLink
                variant="secondary"
                to={`${runsPath}?runsCursor=${encodeURIComponent(nextCursor)}`}
              >
                Older runs
              </ButtonLink>
            </div>
          ) : null}
        </div>

        <div
          className={`${selectedRunId ? "block" : "hidden lg:block"} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <Outlet />
        </div>
      </section>
    </div>
  );
}
