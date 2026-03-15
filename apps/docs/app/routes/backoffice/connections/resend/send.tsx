import { useEffect, useRef } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
} from "react-router";

import type { ResendEmailRecord, ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { FormContainer, FormField } from "@/components/backoffice";

import type { Route } from "./+types/send";
import { fetchResendConfig, sendResendEmail } from "./data";
import { type ResendLayoutContext } from "./shared";

type ResendSendLoaderData = {
  configError: string | null;
};

type ResendSendActionData = {
  ok: boolean;
  message: string;
  record?: ResendEmailRecord;
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

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchResendConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
    } satisfies ResendSendLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  return {
    configError: null,
  } satisfies ResendSendLoaderData;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };

  const to = parseAddressList(getValue("to"));
  const subject = getValue("subject").trim();
  const text = getValue("text").trim();
  const html = getValue("html").trim();
  const scheduledInValueRaw = getValue("scheduledInValue").trim();
  const scheduledInUnit = getValue("scheduledInUnit").trim();

  if (to.length === 0) {
    return {
      ok: false,
      message: "At least one recipient is required.",
    } satisfies ResendSendActionData;
  }

  if (!subject) {
    return { ok: false, message: "Subject is required." } satisfies ResendSendActionData;
  }

  if (!text && !html) {
    return {
      ok: false,
      message: "Provide either a text or HTML body.",
    } satisfies ResendSendActionData;
  }

  let scheduledIn: ResendSendEmailInput["scheduledIn"];
  if (scheduledInValueRaw) {
    const value = Number(scheduledInValueRaw);
    if (!Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        message: "Scheduled delay must be a positive number.",
      } satisfies ResendSendActionData;
    }

    if (scheduledInUnit === "hours") {
      scheduledIn = { hours: value };
    } else if (scheduledInUnit === "days") {
      scheduledIn = { days: value };
    } else {
      scheduledIn = { minutes: value };
    }
  }

  const payload: ResendSendEmailInput = {
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
    from: parseOptionalValue(getValue("from")),
    replyTo: parseOptionalList(getValue("replyTo")),
    cc: parseOptionalList(getValue("cc")),
    bcc: parseOptionalList(getValue("bcc")),
    scheduledIn,
  };

  const result = await sendResendEmail(request, context, params.orgId, payload);
  if (result.error || !result.record) {
    return {
      ok: false,
      message: result.error ?? "Failed to queue email.",
    } satisfies ResendSendActionData;
  }

  return {
    ok: true,
    message: "Email queued for delivery.",
    record: result.record,
  } satisfies ResendSendActionData;
}

export default function BackofficeOrganisationResendSend() {
  const { configError } = useLoaderData<typeof loader>();
  const { orgId, configState } = useOutletContext<ResendLayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement | null>(null);
  const isSending = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.ok) {
      formRef.current?.reset();
    }
  }, [actionData]);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  const defaultFrom = configState?.config?.defaultFrom ?? "";
  const defaultReplyTo = configState?.config?.defaultReplyTo?.join(", ") ?? "";
  const sendError = actionData && !actionData.ok ? actionData.message : null;
  const sendSuccess = actionData && actionData.ok ? actionData.message : null;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Delivery"
        title="Send email"
        description="Queue a message through the Resend fragment and track status in the outbox."
        actions={
          <Link
            to={`/backoffice/connections/resend/${orgId}/outbox`}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            View outbox
          </Link>
        }
      >
        <Form ref={formRef} method="post" className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="To" hint="Comma or newline separated list.">
              <input
                name="to"
                required
                placeholder="hello@resend.dev, ops@example.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="Subject" hint="Short summary line shown in the inbox preview.">
              <input
                name="subject"
                required
                placeholder="What would you like to send?"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <FormField
              label="From"
              hint={
                defaultFrom
                  ? `Defaults to ${defaultFrom}.`
                  : "Leave blank to use the configured default."
              }
            >
              <input
                name="from"
                defaultValue={defaultFrom}
                placeholder={defaultFrom || "onboarding@yourdomain.com"}
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField
              label="Reply-to"
              hint={
                defaultReplyTo
                  ? `Defaults to ${defaultReplyTo}.`
                  : "Optional. Use commas for multiple addresses."
              }
            >
              <input
                name="replyTo"
                defaultValue={defaultReplyTo}
                placeholder={defaultReplyTo || "support@yourdomain.com"}
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="CC" hint="Optional. Use commas for multiple addresses.">
              <input
                name="cc"
                placeholder="finance@yourdomain.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="BCC" hint="Optional. Use commas for multiple addresses.">
              <input
                name="bcc"
                placeholder="audit@yourdomain.com"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
          </div>

          <FormField label="Schedule in" hint="Optional delay from now (uses database time).">
            <div className="flex flex-wrap gap-2">
              <input
                name="scheduledInValue"
                type="number"
                min="1"
                step="1"
                placeholder="15"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none md:w-36"
              />
              <select
                name="scheduledInUnit"
                defaultValue="minutes"
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </FormField>

          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Text" hint="Provide either text or HTML.">
              <textarea
                name="text"
                rows={6}
                placeholder="Write the plain text version of the email..."
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>
            <FormField label="HTML" hint="Optional rich HTML body.">
              <textarea
                name="html"
                rows={6}
                placeholder="<p>Hello from Resend...</p>"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
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
            {isSending ? "Sending…" : "Send email"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
