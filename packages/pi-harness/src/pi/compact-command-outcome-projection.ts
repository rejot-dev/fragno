import { z } from "zod";

import {
  asPersistedPiHarnessStepResult,
  type PiProjectionSessionIdentity,
} from "./session-entry-projection";
import {
  PI_SESSION_COMMAND_STEP_PREFIX,
  PiSessionDataIntegrityError,
  type PiCompactCommandOutcome,
} from "./types";

const compactCommandOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    kind: z.literal("compact"),
    commandId: z.string(),
    status: z.literal("succeeded"),
  }),
  z.object({
    kind: z.literal("compact"),
    commandId: z.string(),
    status: z.literal("rejected"),
    code: z.enum(["nothing_to_compact", "compaction_failed"]),
    message: z.string(),
  }),
]) satisfies z.ZodType<PiCompactCommandOutcome>;

const parseCompactCommandOutcome = (
  value: unknown,
  identity: PiProjectionSessionIdentity,
): PiCompactCommandOutcome | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { kind?: unknown }).kind !== "compact"
  ) {
    return null;
  }

  const outcome = compactCommandOutcomeSchema.safeParse(value);
  if (!outcome.success) {
    throw new PiSessionDataIntegrityError(
      identity.workflowName,
      identity.sessionId,
      new Error("Persisted Pi compact command outcome is invalid.", { cause: outcome.error }),
    );
  }
  return outcome.data;
};

export const projectPiCompactCommandOutcomes = (
  steps: readonly { stepKey: string; status: string; result: unknown }[],
  identity: PiProjectionSessionIdentity,
): {
  byCommandId: Readonly<Record<string, PiCompactCommandOutcome>>;
  latestCommandCompactOutcome: PiCompactCommandOutcome | null;
} => {
  const byCommandId: Record<string, PiCompactCommandOutcome> = {};
  let latestCommandCompactOutcome: PiCompactCommandOutcome | null = null;

  for (const step of steps) {
    if (step.status !== "completed" || !step.stepKey.startsWith(PI_SESSION_COMMAND_STEP_PREFIX)) {
      continue;
    }

    const result = asPersistedPiHarnessStepResult(step.result);
    if (!result) {
      throw new PiSessionDataIntegrityError(
        identity.workflowName,
        identity.sessionId,
        new Error(`Pi command step ${step.stepKey} does not contain a harness result.`),
      );
    }
    if (result.outcome !== "completed") {
      continue;
    }

    latestCommandCompactOutcome = parseCompactCommandOutcome(result.value, identity);
    if (latestCommandCompactOutcome) {
      byCommandId[latestCommandCompactOutcome.commandId] = latestCommandCompactOutcome;
    }
  }

  return { byCommandId, latestCommandCompactOutcome };
};
