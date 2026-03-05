import { Link, Outlet, redirect, useLoaderData, useOutletContext, useParams } from "react-router";
import type { ResendEmailSummary } from "@fragno-dev/resend-fragment";
import type { Route } from "./+types/outbox";
import { fetchResendConfig, fetchResendOutbox } from "./data";
import { formatTimestamp, type ResendLayoutContext } from "./shared";

type ResendOutboxLoaderData = {
  configError: string | null;
  outboxError: string | null;
  emails: ResendEmailSummary[];
  cursor?: string;
  hasNextPage: boolean;
};

export type ResendOutboxOutletContext = {
  emails: ResendEmailSummary[];
  selectedEmailId: string | null;
  basePath: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchResendConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      outboxError: null,
      emails: [],
      cursor: undefined,
      hasNextPage: false,
    } satisfies ResendOutboxLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  const { emails, cursor, hasNextPage, outboxError } = await fetchResendOutbox(
    request,
    context,
    params.orgId,
    { order: "desc", pageSize: 50 },
  );

  return {
    configError: null,
    outboxError,
    emails,
    cursor,
    hasNextPage,
  } satisfies ResendOutboxLoaderData;
}

export default function BackofficeOrganisationResendOutbox() {
  const { emails, configError, outboxError, hasNextPage } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<ResendLayoutContext>();
  const { emailId } = useParams();
  const selectedEmailId = emailId ?? null;
  const basePath = `/backoffice/connections/resend/${orgId}/outbox`;
  const isDetailRoute = Boolean(selectedEmailId);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (outboxError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{outboxError}</div>
    );
  }

  if (!emails.length) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No emails yet. Use the Send tab to queue your first message.
      </div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.35fr]">
      <div
        className={`${listVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Outbox
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Email activity</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
            {emails.length} shown
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {emails.map((email) => {
            const subject = email.subject ?? "(No subject)";
            const recipients = email.to.join(", ") || "(None)";
            const isSelected = email.id === selectedEmailId;
            const statusTone = email.status
              ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
              : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
            const timingLabel = email.sentAt
              ? `Sent ${formatTimestamp(email.sentAt)}`
              : email.scheduledAt
                ? `Scheduled ${formatTimestamp(email.scheduledAt)}`
                : "Not sent";
            const eventTimestamp = formatTimestamp(email.lastEventAt);
            const eventLabel = email.lastEventType
              ? eventTimestamp
                ? `${email.lastEventType} · ${eventTimestamp}`
                : email.lastEventType
              : null;
            const errorLabel = email.errorCode
              ? `${email.errorCode}: ${email.errorMessage ?? ""}`.trim()
              : null;

            return (
              <Link
                key={email.id}
                to={`${basePath}/${email.id}`}
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
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">{recipients}</p>
                    {email.from ? (
                      <p className="mt-1 text-xs text-[var(--bo-muted-2)]">From: {email.from}</p>
                    ) : null}
                  </div>
                  <span
                    className={`border px-2 py-1 text-[9px] uppercase tracking-[0.22em] ${statusTone}`}
                  >
                    {email.status}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--bo-muted-2)]">
                  <span>{timingLabel}</span>
                  {eventLabel ? <span>· {eventLabel}</span> : null}
                </div>
                {errorLabel ? <p className="mt-2 text-[11px] text-red-500">{errorLabel}</p> : null}
              </Link>
            );
          })}
        </div>

        {hasNextPage ? (
          <p className="mt-4 text-xs text-[var(--bo-muted-2)]">
            Showing the latest 50 emails. Use pagination in the fragment API to load more.
          </p>
        ) : null}
      </div>

      <div
        className={`${detailVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            emails,
            selectedEmailId,
            basePath,
          }}
        />
      </div>
    </section>
  );
}
