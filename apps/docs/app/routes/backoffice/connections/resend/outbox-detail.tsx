import { Link, useLoaderData, useOutletContext, useParams } from "react-router";

import type { ResendEmailInput } from "@fragno-dev/resend-fragment";

import type { Route } from "./+types/outbox-detail";
import { fetchResendEmailDetail } from "./data";
import type { ResendOutboxOutletContext } from "./outbox";
import { formatTimestamp } from "./shared";

type ResendOutboxDetailLoaderData = {
  email: Awaited<ReturnType<typeof fetchResendEmailDetail>>["email"];
  error: string | null;
};

const normalizeAddressList = (value?: string | string[] | null) => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.emailId) {
    throw new Response("Not Found", { status: 404 });
  }

  const result = await fetchResendEmailDetail(request, context, params.orgId, params.emailId);
  return {
    email: result.email,
    error: result.error,
  } satisfies ResendOutboxDetailLoaderData;
}

export default function BackofficeOrganisationResendOutboxDetail() {
  const { email, error } = useLoaderData<typeof loader>();
  const { basePath } = useOutletContext<ResendOutboxOutletContext>();
  const { emailId } = useParams();

  if (!emailId || error || !email) {
    return (
      <div className="space-y-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Email detail
        </p>
        <p>{error ?? "We could not find that email in the current outbox page."}</p>
        <p className="text-xs text-[var(--bo-muted-2)]">
          The outbox shows the most recent 50 emails. Use pagination in the fragment API to load
          older messages.
        </p>
        <Link
          to={basePath}
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to outbox
        </Link>
      </div>
    );
  }

  const payload = (email.payload ?? {}) as Partial<ResendEmailInput> & {
    html?: string;
    text?: string;
    headers?: Record<string, string>;
    tags?: { name: string; value: string }[];
  };
  const subject =
    typeof payload.subject === "string" && payload.subject.trim()
      ? payload.subject
      : "(No subject)";
  const payloadToList = normalizeAddressList(payload.to);
  const payloadTo = payloadToList.join(", ");
  const recipients = payloadTo || "(None)";
  const payloadCc = normalizeAddressList(payload.cc).join(", ");
  const payloadBcc = normalizeAddressList(payload.bcc).join(", ");
  const payloadReplyTo = normalizeAddressList(payload.replyTo).join(", ");
  const payloadFrom = typeof payload.from === "string" ? payload.from : "";
  const textBody = typeof payload.text === "string" ? payload.text : "";
  const htmlBody = typeof payload.html === "string" ? payload.html : "";
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
    : "—";
  const errorLabel = email.errorCode
    ? `${email.errorCode}: ${email.errorMessage ?? ""}`.trim()
    : "—";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Email</p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{subject}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">ID: {email.id}</p>
          {email.resendId ? (
            <p className="text-xs text-[var(--bo-muted-2)]">Resend ID: {email.resendId}</p>
          ) : null}
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to outbox
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Recipients
          </p>
          <p className="mt-2 text-sm text-[var(--bo-fg)]">{recipients}</p>
          {payloadFrom ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">From: {payloadFrom}</p>
          ) : null}
          {payloadReplyTo ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">Reply-to: {payloadReplyTo}</p>
          ) : null}
          {payloadCc ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">CC: {payloadCc}</p>
          ) : null}
          {payloadBcc ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">BCC: {payloadBcc}</p>
          ) : null}
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Status</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${statusTone}`}
            >
              {email.status}
            </span>
            <span className="text-xs text-[var(--bo-muted-2)]">{timingLabel}</span>
          </div>
        </section>
      </div>

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Timeline</p>
        <div className="mt-2 space-y-2 text-xs text-[var(--bo-muted-2)]">
          <p>
            Created: <span className="text-[var(--bo-fg)]">{formatTimestamp(email.createdAt)}</span>
          </p>
          <p>
            Updated: <span className="text-[var(--bo-fg)]">{formatTimestamp(email.updatedAt)}</span>
          </p>
          <p>
            Event: <span className="text-[var(--bo-fg)]">{eventLabel}</span>
          </p>
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Text body
          </p>
          <pre className="mt-2 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            {textBody || "—"}
          </pre>
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            HTML body
          </p>
          <pre className="mt-2 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            {htmlBody || "—"}
          </pre>
        </section>
      </div>

      {(payload.tags && payload.tags.length > 0) || payload.headers ? (
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Metadata
          </p>
          {payload.tags && payload.tags.length > 0 ? (
            <div className="mt-2 text-xs text-[var(--bo-muted-2)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Tags
              </p>
              <pre className="mt-1 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
                {JSON.stringify(payload.tags, null, 2)}
              </pre>
            </div>
          ) : null}
          {payload.headers ? (
            <div className="mt-3 text-xs text-[var(--bo-muted-2)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Headers
              </p>
              <pre className="mt-1 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
                {JSON.stringify(payload.headers, null, 2)}
              </pre>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Errors</p>
        <p className="mt-2 text-sm text-[var(--bo-fg)]">{errorLabel}</p>
      </section>
    </div>
  );
}
