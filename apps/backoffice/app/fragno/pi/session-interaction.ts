import type { PiWorkflowSessionProjectionState } from "@fragno-dev/pi-harness/workflow-session-projection";

export const projectPiSessionInteraction = ({
  sessionDisabled,
  sending,
  localCompactionPending,
  projection,
}: {
  sessionDisabled: boolean;
  sending: boolean;
  localCompactionPending: boolean;
  projection: Pick<
    PiWorkflowSessionProjectionState,
    "activeCommand" | "activity" | "readyForInput"
  >;
}) => {
  const compacting =
    !sessionDisabled && (projection.activeCommand?.kind === "compact" || localCompactionPending);
  const readyForInput = !sessionDisabled && !sending && !compacting && projection.readyForInput;
  const running = !sessionDisabled && (sending || compacting || !projection.readyForInput);
  const needsNudge =
    !sessionDisabled &&
    !sending &&
    !compacting &&
    projection.activeCommand === null &&
    !readyForInput &&
    projection.activity === "working";

  return { compacting, readyForInput, running, needsNudge };
};
