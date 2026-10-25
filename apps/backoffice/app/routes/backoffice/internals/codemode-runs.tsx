import { ButtonLink } from "@fragno-private/design-system/button";
import { ListRow, RowList } from "@fragno-private/design-system/list-row";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfacePanelFooter,
  SurfacePanelRows,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Outlet, useLoaderData, useParams } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/codemode-runs";
import { internalsScopeBasePath } from "./internals-scope";
import { formatTimestamp, stepStatusTone } from "./workflows-shared";

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
  const { internalsBasePath, runs, nextCursor } = useLoaderData<typeof loader>();
  const { runId: selectedRunId } = useParams();
  const runsPath = `${internalsBasePath}/codemode`;

  return (
    <section className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <div className={`${selectedRunId ? "hidden lg:block" : "block"} min-w-0`}>
        <SurfacePanel
          caption={`${runs.length} ${runs.length === 1 ? "run" : "runs"} · newest first`}
          actions={null}
        >
          {runs.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="No codemode runs in this scope."
              description="Runs and their tool calls are kept for 7 days."
              flush
            />
          ) : (
            <SurfacePanelRows>
              <RowList empty={null}>
                {runs.map((run) => (
                  <ListRow
                    key={run.id}
                    to={`${runsPath}/${encodeURIComponent(run.id)}`}
                    leading={null}
                    title={run.origin}
                    detail={`${run.activationKind} · ${formatTimestamp(run.createdAt)}`}
                    trailing={
                      <BackofficeStatusLight tone={stepStatusTone(run.status)}>
                        {run.status}
                      </BackofficeStatusLight>
                    }
                    expansion={null}
                  />
                ))}
              </RowList>
            </SurfacePanelRows>
          )}
          {nextCursor ? (
            <SurfacePanelFooter>
              <ButtonLink
                variant="secondary"
                to={`${runsPath}?runsCursor=${encodeURIComponent(nextCursor)}`}
              >
                Older runs
              </ButtonLink>
            </SurfacePanelFooter>
          ) : null}
        </SurfacePanel>
      </div>

      <div className={`${selectedRunId ? "block" : "hidden lg:block"} min-w-0`}>
        <Outlet />
      </div>
    </section>
  );
}
