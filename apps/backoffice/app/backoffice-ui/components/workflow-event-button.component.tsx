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
  const danger = props.variant === "danger";

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
      <button
        type="button"
        disabled={disabled}
        aria-describedby={error ? errorId : undefined}
        onClick={(event) => void submit(event.currentTarget.form)}
        className={`inline-flex min-h-10 items-center justify-center px-4 text-xs font-semibold transition-[background-color,border-color,color,scale,opacity] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 ${
          danger
            ? "border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)] hover:bg-red-500/15"
            : "border border-[color:var(--bo-accent)] bg-[var(--bo-accent)] text-white hover:bg-[var(--bo-accent-strong)]"
        }`}
      >
        {label}
      </button>
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
