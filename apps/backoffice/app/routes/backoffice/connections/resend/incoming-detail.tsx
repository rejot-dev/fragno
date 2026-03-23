import { Link, useLoaderData, useOutletContext, useParams } from "react-router";

import type { Route } from "./+types/incoming-detail";
import { fetchResendReceivedEmailDetail } from "./data";
import type { ResendIncomingOutletContext } from "./incoming";
import { formatTimestamp } from "./shared";

type ResendIncomingDetailLoaderData = {
  email: Awaited<ReturnType<typeof fetchResendReceivedEmailDetail>>["email"];
  error: string | null;
};

const formatAddressList = (value?: string[] | null) => {
  if (!value || value.length === 0) {
    return "—";
  }
  return value.join(", ");
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.emailId) {
    throw new Response("Not Found", { status: 404 });
  }

  const result = await fetchResendReceivedEmailDetail(
    request,
    context,
    params.orgId,
    params.emailId,
  );
  return {
    email: result.email,
    error: result.error,
  } satisfies ResendIncomingDetailLoaderData;
}

export default function BackofficeOrganisationResendIncomingDetail() {
  const { email, error } = useLoaderData<typeof loader>();
  const { basePath } = useOutletContext<ResendIncomingOutletContext>();
  const { emailId } = useParams();

  if (!emailId || error || !email) {
    return (
      <div className="space-y-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Incoming detail
        </p>
        <p>{error ?? "We could not find that email in the current incoming page."}</p>
        <Link
          to={basePath}
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to incoming
        </Link>
      </div>
    );
  }

  const textBody = email.text ?? "";
  const htmlBody = email.html ?? "";

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Incoming
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{email.subject}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">ID: {email.id}</p>
          <p className="text-xs text-[var(--bo-muted-2)]">Message-ID: {email.messageId}</p>
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to incoming
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Envelope
          </p>
          <div className="mt-2 space-y-2 text-xs text-[var(--bo-muted-2)]">
            <p>
              From: <span className="text-[var(--bo-fg)]">{email.from}</span>
            </p>
            <p>
              To: <span className="text-[var(--bo-fg)]">{formatAddressList(email.to)}</span>
            </p>
            <p>
              Reply-to:{" "}
              <span className="text-[var(--bo-fg)]">{formatAddressList(email.replyTo)}</span>
            </p>
            <p>
              CC: <span className="text-[var(--bo-fg)]">{formatAddressList(email.cc)}</span>
            </p>
            <p>
              BCC: <span className="text-[var(--bo-fg)]">{formatAddressList(email.bcc)}</span>
            </p>
          </div>
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Timeline
          </p>
          <div className="mt-2 space-y-2 text-xs text-[var(--bo-muted-2)]">
            <p>
              Received:{" "}
              <span className="text-[var(--bo-fg)]">{formatTimestamp(email.createdAt)}</span>
            </p>
            <p>
              Attachments: <span className="text-[var(--bo-fg)]">{email.attachmentCount}</span>
            </p>
            {email.raw ? (
              <p>
                Raw MIME:{" "}
                <a
                  href={email.raw.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--bo-accent-fg)] underline underline-offset-2"
                >
                  download
                </a>
              </p>
            ) : null}
          </div>
        </section>
      </div>

      {email.attachments.length > 0 ? (
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Attachments
          </p>
          <div className="mt-2 space-y-2">
            {email.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-xs text-[var(--bo-muted-2)]"
              >
                <p className="font-semibold text-[var(--bo-fg)]">
                  {attachment.filename ?? attachment.id}
                </p>
                <p className="mt-1">
                  {attachment.contentType} · {attachment.size} bytes
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <section className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Text body
          </p>
          <pre className="mt-2 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            {textBody || "—"}
          </pre>
        </section>

        <section className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            HTML body
          </p>
          <pre className="mt-2 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            {htmlBody || "—"}
          </pre>
        </section>
      </div>

      {email.headers ? (
        <section className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Headers
          </p>
          <div className="mt-2 w-full max-w-full overflow-x-auto overflow-y-hidden">
            <pre className="w-max min-w-full text-xs whitespace-pre text-[var(--bo-fg)]">
              {JSON.stringify(email.headers, null, 2)}
            </pre>
          </div>
        </section>
      ) : null}
    </div>
  );
}
