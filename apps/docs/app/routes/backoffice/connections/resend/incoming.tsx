import { Link, Outlet, redirect, useLoaderData, useOutletContext, useParams } from "react-router";

import type { ResendReceivedEmailSummary } from "@fragno-dev/resend-fragment";

import type { Route } from "./+types/incoming";
import { fetchResendConfig, fetchResendReceivedEmails } from "./data";
import { formatTimestamp, type ResendLayoutContext } from "./shared";

type ResendIncomingLoaderData = {
  configError: string | null;
  incomingError: string | null;
  emails: ResendReceivedEmailSummary[];
  cursor?: string;
  hasNextPage: boolean;
};

export type ResendIncomingOutletContext = {
  emails: ResendReceivedEmailSummary[];
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
      incomingError: null,
      emails: [],
      cursor: undefined,
      hasNextPage: false,
    } satisfies ResendIncomingLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  const { emails, cursor, hasNextPage, incomingError } = await fetchResendReceivedEmails(
    request,
    context,
    params.orgId,
    { order: "desc", pageSize: 50 },
  );

  return {
    configError: null,
    incomingError,
    emails,
    cursor,
    hasNextPage,
  } satisfies ResendIncomingLoaderData;
}

export default function BackofficeOrganisationResendIncoming() {
  const { emails, configError, incomingError, hasNextPage } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<ResendLayoutContext>();
  const { emailId } = useParams();
  const selectedEmailId = emailId ?? null;
  const basePath = `/backoffice/connections/resend/${orgId}/incoming`;
  const isDetailRoute = Boolean(selectedEmailId);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (incomingError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">
        {incomingError}
      </div>
    );
  }

  if (!emails.length) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No incoming emails yet. Once receiving is configured and Resend delivers a webhook, messages
        will appear here.
      </div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
      <div
        className={`${listVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Incoming
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Received email log</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {emails.length} shown
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {emails.map((email) => {
            const isSelected = email.id === selectedEmailId;
            const subject = email.subject || "(No subject)";
            const recipients = email.to.join(", ") || "(No recipients)";
            const attachmentLabel =
              email.attachmentCount > 0
                ? `${email.attachmentCount} attachment${email.attachmentCount === 1 ? "" : "s"}`
                : "No attachments";

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
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">From: {email.from}</p>
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">To: {recipients}</p>
                  </div>
                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                    Incoming
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--bo-muted-2)]">
                  <span>{formatTimestamp(email.createdAt)}</span>
                  <span>·</span>
                  <span>{attachmentLabel}</span>
                </div>
              </Link>
            );
          })}
        </div>

        {hasNextPage ? (
          <p className="mt-4 text-xs text-[var(--bo-muted-2)]">
            Showing the latest 50 incoming emails. Use pagination in the fragment API to load more.
          </p>
        ) : null}
      </div>

      <div
        className={`${detailVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
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
