import type { PiSessionCommandPayload } from "./types";

export type PiSessionDurableCommand = Extract<
  PiSessionCommandPayload,
  { kind: "prompt" | "skill" | "promptFromTemplate" | "compact" }
>;

export type PiSessionActiveCommand = Pick<PiSessionDurableCommand, "commandId" | "kind">;

/** Identifies the interactive command owning an active workflow step. */
export type PiSessionCommandStartEmission = {
  kind: "pi-session-command-start";
  command: PiSessionActiveCommand;
};
