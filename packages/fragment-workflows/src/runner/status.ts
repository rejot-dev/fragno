// Status predicates used to short-circuit runner operations.

export const isTerminalStatus = (status: string) =>
  status === "complete" || status === "terminated" || status === "errored";

export const isPausedStatus = (status: string) =>
  status === "paused" || status === "waitingForPause";
