import { Button } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, useOutletContext } from "react-router";

import type { ResendSendEmailInput, ResendThreadMutationOutput } from "@fragno-dev/resend-fragment";

import { resolveAuthenticatedIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/thread-start";
import { createResendThread } from "./data";
import { EmailComposeFields } from "./email-compose-fields";
import type { ResendThreadsOutletContext } from "./threads";

type ResendStartThreadActionData =
  | {
      ok: true;
      message: string;
      threadId: string;
      result: ResendThreadMutationOutput;
    }
  | {
      ok: false;
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
    } satisfies ResendStartThreadActionData;
  }

  if (!subject) {
    return {
      ok: false,
      message: "Subject is required.",
    } satisfies ResendStartThreadActionData;
  }

  if (!text && !html) {
    return {
      ok: false,
      message: "Provide either a text or HTML body.",
    } satisfies ResendStartThreadActionData;
  }

  let scheduledIn: ResendSendEmailInput["scheduledIn"];
  if (scheduledInValueRaw) {
    const value = Number(scheduledInValueRaw);
    if (!Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        message: "Scheduled delay must be a positive number.",
      } satisfies ResendStartThreadActionData;
    }

    switch (scheduledInUnit) {
      case "hours":
        scheduledIn = { hours: value };
        break;
      case "days":
        scheduledIn = { days: value };
        break;
      case "minutes":
        scheduledIn = { minutes: value };
        break;
      default:
        return {
          ok: false,
          message: 'Scheduled delay unit must be "minutes", "hours", or "days".',
        } satisfies ResendStartThreadActionData;
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

  const result = await createResendThread(request, context, scope, payload);
  if (result.error || !result.result?.thread.id) {
    return {
      ok: false,
      message: result.error ?? "Failed to create thread.",
    } satisfies ResendStartThreadActionData;
  }

  return {
    ok: true,
    message: "Thread queued for delivery.",
    threadId: result.result.thread.id,
    result: result.result,
  } satisfies ResendStartThreadActionData;
}

export default function BackofficeOrganizationResendThreadStart() {
  const outletContext = useOutletContext<ResendThreadsOutletContext | null>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  useEffect(() => {
    if (!outletContext || !fetcher.data) {
      return;
    }

    if (fetcher.data.ok) {
      if (!fetcher.data.threadId) {
        setNavigationError("Thread was created, but no thread id was returned.");
        return;
      }

      formRef.current?.reset();
      setNavigationError(null);
      void navigate(`${outletContext.basePath}/${encodeURIComponent(fetcher.data.threadId)}`);
      return;
    }

    setNavigationError(null);
  }, [fetcher.data, navigate, outletContext]);

  if (!outletContext) {
    return (
      <div className="rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Unable to initialize the thread composer. Reload this page and try again.
      </div>
    );
  }

  const isSending = fetcher.state !== "idle";
  const defaultFrom = outletContext.configState?.config?.defaultFrom ?? "";
  const defaultReplyTo = outletContext.configState?.config?.defaultReplyTo?.join(", ") ?? "";
  const sendError =
    (fetcher.data && !fetcher.data.ok ? fetcher.data.message : null) ?? navigationError;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Threads"
        title="Start thread"
        description="Send the first message in a new tracked conversation. The created thread will appear in the list on the left."
      >
        <fetcher.Form ref={formRef} method="post" className="space-y-3">
          <EmailComposeFields
            defaultFrom={defaultFrom}
            defaultReplyTo={defaultReplyTo}
            subjectHint="Required for the first message in the thread."
            subjectPlaceholder="What would you like to discuss?"
            textPlaceholder="Write the plain text version of the first message..."
            bodyColumnsFrom="lg"
          />

          {sendError ? <p className="text-xs text-red-500">{sendError}</p> : null}

          <Button variant="accent" type="submit" disabled={isSending} className="w-full">
            {isSending ? "Creating…" : "Start thread"}
          </Button>
        </fetcher.Form>
      </FormContainer>
    </div>
  );
}
