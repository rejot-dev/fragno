import { ScrollArea } from "@base-ui/react/scroll-area";
import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useOutletContext, useParams } from "react-router";

import type { ResendThreadMessage, ResendThreadReplyInput } from "@fragno-dev/resend-fragment";

import { FormField } from "@/components/backoffice";

import type { Route } from "./+types/thread-detail";
import { fetchResendThreadDetail, replyToResendThread } from "./data";
import { formatTimestamp } from "./shared";
import type { ResendThreadsOutletContext } from "./threads";

type ResendThreadDetailLoaderData = {
  thread: Awaited<ReturnType<typeof fetchResendThreadDetail>>["thread"];
  messages: ResendThreadMessage[];
  hasNextPage: boolean;
  error: string | null;
};

type ResendThreadReplyActionData = {
  ok: boolean;
  message: string;
};

const parseAddressList = (value: string) =>
  value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseOptionalList = (value: string) => {
  const list = parseAddressList(value);
  return list.length > 0 ? list : undefined;
};

const parseOptionalValue = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const formatAddressList = (value?: string[] | null) => {
  if (!value || value.length === 0) {
    return "—";
  }
  return value.join(", ");
};

const getMessageBody = (message: ResendThreadMessage) => message.text ?? message.html ?? "—";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.threadId) {
    throw new Response("Not Found", { status: 404 });
  }

  const result = await fetchResendThreadDetail(request, context, params.orgId, params.threadId, {
    order: "desc",
    pageSize: 100,
  });

  return {
    thread: result.thread,
    messages: result.messages,
    hasNextPage: result.hasNextPage,
    error: result.error,
  } satisfies ResendThreadDetailLoaderData;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId || !params.threadId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };

  const to = parseAddressList(getValue("to"));
  const text = getValue("text").trim();
  const html = getValue("html").trim();

  if (to.length === 0) {
    return {
      ok: false,
      message: "At least one recipient is required.",
    } satisfies ResendThreadReplyActionData;
  }

  if (!text && !html) {
    return {
      ok: false,
      message: "Provide either a text or HTML reply.",
    } satisfies ResendThreadReplyActionData;
  }

  const payload: ResendThreadReplyInput = {
    to,
    cc: parseOptionalList(getValue("cc")),
    bcc: parseOptionalList(getValue("bcc")),
    subject: parseOptionalValue(getValue("subject")),
    text: text || undefined,
    html: html || undefined,
  };

  const result = await replyToResendThread(
    request,
    context,
    params.orgId,
    params.threadId,
    payload,
  );
  if (result.error) {
    return {
      ok: false,
      message: result.error,
    } satisfies ResendThreadReplyActionData;
  }

  return {
    ok: true,
    message: "Reply queued for delivery.",
  } satisfies ResendThreadReplyActionData;
}

export default function BackofficeOrganisationResendThreadDetail() {
  const { thread, messages, hasNextPage, error } = useLoaderData<typeof loader>();
  const outletContext = useOutletContext<ResendThreadsOutletContext | null>();
  if (!outletContext) {
    return (
      <div className="rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Unable to initialize the thread detail view. Reload this page and try again.
      </div>
    );
  }

  const { basePath } = outletContext;
  const { threadId } = useParams();
  const fetcher = useFetcher<typeof action>();
  const [formResetKey, setFormResetKey] = useState(0);

  useEffect(() => {
    if (fetcher.data?.ok) {
      setFormResetKey((value) => value + 1);
    }
  }, [fetcher.data]);

  if (!threadId || !thread) {
    return (
      <div className="space-y-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Thread detail
        </p>
        <p>{error ?? "We could not find that thread."}</p>
        <Link
          to={basePath}
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to threads
        </Link>
      </div>
    );
  }

  const displayMessages = [...messages].reverse();
  const latestInbound = messages.find((message) => message.direction === "inbound") ?? null;
  const latestMessage = messages[0] ?? null;
  const defaultTo =
    (latestInbound?.replyTo.length ? latestInbound.replyTo.join(", ") : latestInbound?.from) ??
    (latestMessage?.to.length ? latestMessage.to.join(", ") : "");
  const defaultCc = latestInbound?.cc.join(", ") ?? "";
  const isSending = fetcher.state !== "idle";
  const sendError = fetcher.data && !fetcher.data.ok ? fetcher.data.message : null;
  const sendSuccess = fetcher.data && fetcher.data.ok ? fetcher.data.message : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Thread</p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
            {thread.subject || "(No subject)"}
          </h3>
          <p className="text-xs text-[var(--bo-muted-2)]">{thread.messageCount} messages</p>
          {thread.replyToAddress ? (
            <p className="text-xs text-[var(--bo-muted-2)]">Reply alias: {thread.replyToAddress}</p>
          ) : null}
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to threads
        </Link>
      </div>

      {error ? <div className="text-sm text-red-500">{error}</div> : null}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Participants
          </p>
          <p className="mt-2 text-sm text-[var(--bo-fg)]">
            {formatAddressList(thread.participants)}
          </p>
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Activity
          </p>
          <div className="mt-2 space-y-2 text-xs text-[var(--bo-muted-2)]">
            <p>
              Started:{" "}
              <span className="text-[var(--bo-fg)]">{formatTimestamp(thread.firstMessageAt)}</span>
            </p>
            <p>
              Latest:{" "}
              <span className="text-[var(--bo-fg)]">{formatTimestamp(thread.lastMessageAt)}</span>
            </p>
            <p>
              Direction: <span className="text-[var(--bo-fg)]">{thread.lastDirection ?? "—"}</span>
            </p>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Messages
          </p>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            Review the thread history before sending a reply.
          </p>
        </div>

        <ScrollArea.Root className="relative overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
          <ScrollArea.Viewport className="max-h-[480px] p-3">
            <ScrollArea.Content className="space-y-3">
              {displayMessages.length > 0 ? (
                displayMessages.map((message) => (
                  <ThreadMessageCard key={message.id} message={message} />
                ))
              ) : (
                <div className="text-sm text-[var(--bo-muted)]">
                  No messages in this thread yet.
                </div>
              )}
            </ScrollArea.Content>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 p-[2px] select-none">
            <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
          </ScrollArea.Scrollbar>
          <ScrollArea.Corner className="bg-transparent" />
        </ScrollArea.Root>

        {hasNextPage ? (
          <p className="text-xs text-[var(--bo-muted-2)]">
            Showing the latest 100 messages in this thread. Use pagination in the fragment API to
            load more.
          </p>
        ) : null}
      </section>

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
        <div className="space-y-2 border-b border-[color:var(--bo-border)] pb-3">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Reply</p>
          <p>
            Send a reply through the thread route. Fragno will keep the thread headers and reply
            alias intact.
          </p>
        </div>

        <fetcher.Form key={formResetKey} method="post" className="mt-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="To" hint="Comma or newline separated list.">
              <input
                name="to"
                required
                defaultValue={defaultTo}
                placeholder="reply@example.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="Subject" hint="Optional. Defaults to the thread subject.">
              <input
                name="subject"
                defaultValue={thread.subject ?? ""}
                placeholder={thread.subject ?? "Reply subject"}
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="CC" hint="Optional additional recipients.">
              <input
                name="cc"
                defaultValue={defaultCc}
                placeholder="team@example.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="BCC" hint="Optional blind-copy recipients.">
              <input
                name="bcc"
                placeholder="audit@example.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <FormField label="Text" hint="Provide either text or HTML.">
              <textarea
                name="text"
                rows={6}
                placeholder="Write the plain text version of the reply..."
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="HTML" hint="Optional rich HTML body.">
              <textarea
                name="html"
                rows={6}
                placeholder="<p>Thanks for the update...</p>"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          {sendError ? <p className="text-xs text-red-500">{sendError}</p> : null}
          {sendSuccess ? <p className="text-xs text-green-500">{sendSuccess}</p> : null}

          <button
            type="submit"
            disabled={isSending}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {isSending ? "Sending…" : "Send reply"}
          </button>
        </fetcher.Form>
      </section>
    </div>
  );
}

function ThreadMessageCard({ message }: { message: ResendThreadMessage }) {
  const isOutbound = message.direction === "outbound";
  const body = getMessageBody(message);
  const timestamp = formatTimestamp(message.occurredAt);
  const eventLabel = message.lastEventType
    ? message.lastEventAt
      ? `${message.lastEventType} · ${formatTimestamp(message.lastEventAt)}`
      : message.lastEventType
    : null;
  const errorLabel = message.errorCode
    ? `${message.errorCode}: ${message.errorMessage ?? ""}`.trim()
    : null;

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <article
        className={
          isOutbound
            ? "w-full max-w-[92%] border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3 text-[var(--bo-accent-fg)]"
            : "w-full max-w-[92%] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-[var(--bo-muted)]"
        }
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-[var(--bo-fg)]">
              {message.from ?? (isOutbound ? "Configured sender" : "Unknown sender")}
            </p>
            <p className="mt-1 text-[11px] text-[var(--bo-muted-2)]">{timestamp}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {message.direction}
            </span>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {message.status}
            </span>
          </div>
        </div>

        <div className="mt-3 space-y-1 text-xs text-[var(--bo-muted-2)]">
          <p>
            To: <span className="text-[var(--bo-fg)]">{formatAddressList(message.to)}</span>
          </p>
          {message.replyTo.length > 0 ? (
            <p>
              Reply-to:{" "}
              <span className="text-[var(--bo-fg)]">{formatAddressList(message.replyTo)}</span>
            </p>
          ) : null}
          {message.cc.length > 0 ? (
            <p>
              CC: <span className="text-[var(--bo-fg)]">{formatAddressList(message.cc)}</span>
            </p>
          ) : null}
          {message.bcc.length > 0 ? (
            <p>
              BCC: <span className="text-[var(--bo-fg)]">{formatAddressList(message.bcc)}</span>
            </p>
          ) : null}
        </div>

        <pre className="mt-3 text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
          {body}
        </pre>

        {message.attachments.length > 0 ? (
          <div className="mt-3 space-y-2">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Attachments
            </p>
            {message.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-2 text-xs text-[var(--bo-muted-2)]"
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
        ) : null}

        {eventLabel ? (
          <p className="mt-3 text-xs text-[var(--bo-muted-2)]">Event: {eventLabel}</p>
        ) : null}
        {errorLabel ? <p className="mt-2 text-xs text-red-500">{errorLabel}</p> : null}
      </article>
    </div>
  );
}
