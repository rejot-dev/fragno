import {
  Link,
  Outlet,
  redirect,
  useLoaderData,
  useLocation,
  useOutletContext,
  useParams,
} from "react-router";

import type { ResendThreadSummary } from "@fragno-dev/resend-fragment";

import type { Route } from "./+types/threads";
import { fetchResendConfig, fetchResendThreads } from "./data";
import { formatTimestamp, type ResendConfigState, type ResendLayoutContext } from "./shared";

type ResendThreadsLoaderData = {
  configError: string | null;
  threadsError: string | null;
  threads: ResendThreadSummary[];
  cursor?: string;
  hasNextPage: boolean;
};

export type ResendThreadsOutletContext = {
  threads: ResendThreadSummary[];
  selectedThreadId: string | null;
  isStartRoute: boolean;
  basePath: string;
  orgId: string;
  configState: ResendConfigState | null;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchResendConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      threadsError: null,
      threads: [],
      cursor: undefined,
      hasNextPage: false,
    } satisfies ResendThreadsLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  const { threads, cursor, hasNextPage, threadsError } = await fetchResendThreads(
    request,
    context,
    params.orgId,
    { order: "desc", pageSize: 50 },
  );

  return {
    configError: null,
    threadsError,
    threads,
    cursor,
    hasNextPage,
  } satisfies ResendThreadsLoaderData;
}

export default function BackofficeOrganisationResendThreads() {
  const { threads, configError, threadsError, hasNextPage } = useLoaderData<typeof loader>();
  const { orgId, configState } = useOutletContext<ResendLayoutContext>();
  const { threadId } = useParams();
  const location = useLocation();
  const selectedThreadId = threadId ?? null;
  const basePath = `/backoffice/connections/resend/${orgId}/threads`;
  const isStartRoute = location.pathname.replace(/\/+$/, "").endsWith("/start");
  const isDetailRoute = Boolean(selectedThreadId || isStartRoute);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (threadsError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{threadsError}</div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
      <div
        className={`${listVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Threads
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Conversation threads</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {threads.length} shown
          </span>
        </div>

        <div className="mt-4 space-y-2">
          <Link
            to={`${basePath}/start`}
            aria-current={isStartRoute ? "page" : undefined}
            className={
              isStartRoute
                ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--bo-fg)]">Start thread</p>
                <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                  Compose the first message in a new conversation.
                </p>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                New
              </span>
            </div>
          </Link>

          {threads.length > 0 ? (
            threads.map((thread) => {
              const isSelected = thread.id === selectedThreadId;
              const subject = thread.subject || "(No subject)";
              const participants = thread.participants.join(", ") || "No participants recorded";
              const preview = thread.lastMessagePreview || "No preview available.";
              const directionLabel = thread.lastDirection
                ? `Last ${thread.lastDirection}`
                : "Activity";

              return (
                <Link
                  key={thread.id}
                  to={`${basePath}/${thread.id}`}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    isSelected
                      ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                      : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--bo-fg)]">{subject}</p>
                      <p className="mt-1 text-xs text-[var(--bo-muted-2)]">{participants}</p>
                    </div>
                    <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                      {thread.messageCount} msg
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[var(--bo-muted)]">{preview}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--bo-muted-2)]">
                    <span>{directionLabel}</span>
                    <span>·</span>
                    <span>{formatTimestamp(thread.lastMessageAt)}</span>
                  </div>
                </Link>
              );
            })
          ) : (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-sm text-[var(--bo-muted)]">
              No threads yet. Start a thread to send the first message in a new conversation.
            </div>
          )}
        </div>

        {hasNextPage ? (
          <p className="mt-4 text-xs text-[var(--bo-muted-2)]">
            Showing the latest 50 threads. Use pagination in the fragment API to load more.
          </p>
        ) : null}
      </div>

      <div
        className={`${detailVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            threads,
            selectedThreadId,
            isStartRoute,
            basePath,
            orgId,
            configState,
          }}
        />
      </div>
    </section>
  );
}
