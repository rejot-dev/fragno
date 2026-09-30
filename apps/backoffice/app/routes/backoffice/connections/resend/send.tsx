import { Button } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { useEffect, useRef } from "react";
import { useFetcher, useOutletContext } from "react-router";

import type { ResendEmailRecord, ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import { resolveAuthenticatedIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/send";
import { sendResendEmail } from "./data";
import { EmailComposeFields } from "./email-compose-fields";
import type { ResendOutgoingOutletContext } from "./outbox";

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

export async function action({ request, params, context }: Route.ActionArgs) {
  const integration = await resolveAuthenticatedIntegrationContext({
    request,
    context,
    params,
    integration: "resend",
    allowedScopes: ["org", "system"],
  });
  const scope = integration.scope;

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

  const result = await sendResendEmail(request, context, scope, payload);
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

export default function BackofficeOrganizationResendSend() {
  const { configState } = useOutletContext<ResendOutgoingOutletContext>();
  const fetcher = useFetcher<typeof action>();
  const formRef = useRef<HTMLFormElement | null>(null);
  const isSending = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      formRef.current?.reset();
    }
  }, [fetcher.data]);

  const defaultFrom = configState?.config?.defaultFrom ?? "";
  const defaultReplyTo = configState?.config?.defaultReplyTo?.join(", ") ?? "";
  const sendError = fetcher.data && !fetcher.data.ok ? fetcher.data.message : null;
  const sendSuccess = fetcher.data?.ok ? fetcher.data.message : null;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Delivery"
        title="Send outgoing email"
        description="Queue a message through the Resend fragment. Newly queued messages appear in the list on the left."
      >
        <fetcher.Form ref={formRef} method="post" className="space-y-3">
          <EmailComposeFields
            defaultFrom={defaultFrom}
            defaultReplyTo={defaultReplyTo}
            subjectHint="Short summary line shown in the inbox preview."
            subjectPlaceholder="What would you like to send?"
            textPlaceholder="Write the plain text version of the email..."
            bodyColumnsFrom="md"
          />

          {sendError ? <p className="text-xs text-red-500">{sendError}</p> : null}
          {sendSuccess ? <p className="text-xs text-green-500">{sendSuccess}</p> : null}

          <Button variant="accent" type="submit" disabled={isSending} className="w-full">
            {isSending ? "Sending…" : "Send email"}
          </Button>
        </fetcher.Form>
      </FormContainer>
    </div>
  );
}
