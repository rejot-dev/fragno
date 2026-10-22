import { Button } from "@fragno-private/design-system/button";
import { useId, useState } from "react";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

type SubmissionState = "idle" | "sending" | "sent" | "failed";

export const WorkflowEventButton: ComponentFn<
  typeof backofficeUiCatalog,
  "WorkflowEventButton"
> = ({ props }) => {
  const host = useWorkflowUiInteractionHost();
  const errorId = useId();
  const [eventId] = useState(() => crypto.randomUUID());
  const [submissionState, setSubmissionState] = useState<SubmissionState>("idle");
  const [error, setError] = useState<string>();
  const available = host?.canSendEvent(props.eventType) === true;
  const disabled = !available || submissionState === "sending" || submissionState === "sent";

  const submit = async (form: HTMLFormElement | null) => {
    if (!host || disabled || (form && !form.reportValidity())) {
      return;
    }
    if (props.confirmation && !window.confirm(props.confirmation)) {
      return;
    }

    setSubmissionState("sending");
    setError(undefined);
    try {
      await host.sendEvent({
        eventId,
        eventType: props.eventType,
        payload: props.payload,
      });
      setSubmissionState("sent");
    } catch (cause) {
      setSubmissionState("failed");
      setError(cause instanceof Error ? cause.message : "Could not send workflow input.");
    }
  };

  const label =
    submissionState === "sending"
      ? "Sending…"
      : submissionState === "sent"
        ? "Sent"
        : submissionState === "failed"
          ? "Try again"
          : props.label;

  return (
    <div className="min-w-0">
      <Button
        variant={props.variant === "danger" ? "danger" : "solid"}
        disabled={disabled}
        aria-describedby={error ? errorId : undefined}
        onClick={(event) => void submit(event.currentTarget.form)}
        className="min-h-10 px-4 text-xs"
      >
        {label}
      </Button>
      {host && !available && submissionState !== "sent" ? (
        <p className="mt-1.5 text-[10px] leading-4 text-[var(--bo-muted-2)]">
          This workflow is no longer waiting for {props.eventType}.
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 text-[10px] leading-4 text-[var(--bo-failed)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
};
