import { createId } from "@fragno-dev/db/id";

import type { PiSessionCommandPayload } from "./types";

/** Pi command IDs carry their kind so control commands cannot be mistaken for durable operations. */
export function createPiSessionCommandId(kind: PiSessionCommandPayload["kind"]): string {
  return `${kind}_${createId()}`;
}

/** Classifies a Pi-issued command ID for the command-step wait route. */
export function piSessionCommandWaitability(commandId: string): "waitable" | "control" | "invalid" {
  const match = /^([a-zA-Z]+)_[a-zA-Z0-9_-]+$/u.exec(commandId);
  if (!match) {
    return "invalid";
  }
  switch (match[1]) {
    case "prompt":
    case "skill":
    case "promptFromTemplate":
    case "compact":
      return "waitable";
    case "abort":
    case "steer":
    case "followUp":
      return "control";
    default:
      return "invalid";
  }
}

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
