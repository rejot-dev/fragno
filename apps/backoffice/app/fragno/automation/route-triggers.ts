import { Cron } from "croner";
import { z } from "zod";

export const AUTOMATION_SCHEDULE_SOURCE = "scheduler" as const;
export const AUTOMATION_SCHEDULE_EVENT_TYPE = "schedule.triggered" as const;

type AutomationScheduleErrorCode = "SCHEDULE_CADENCE_INVALID";

class AutomationScheduleError extends Error {
  readonly code: AutomationScheduleErrorCode;

  constructor(code: AutomationScheduleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutomationScheduleError";
    this.code = code;
  }
}

export const isAutomationScheduleError = (
  cause: unknown,
): cause is Error & { readonly code: "SCHEDULE_CADENCE_INVALID" } =>
  cause instanceof AutomationScheduleError;

export const automationScheduleCadenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1),
    timeZone: z.string().trim().min(1).default("UTC"),
  }),
]);

export type AutomationScheduleCadence = z.infer<typeof automationScheduleCadenceSchema>;

const validateTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (cause) {
    throw new AutomationScheduleError(
      "SCHEDULE_CADENCE_INVALID",
      `Invalid IANA time zone '${timeZone}'.`,
      { cause },
    );
  }
};

const createCron = (cadence: Extract<AutomationScheduleCadence, { kind: "cron" }>) => {
  validateTimeZone(cadence.timeZone);
  try {
    return new Cron(cadence.expression, {
      paused: true,
      mode: "5-part",
      timezone: cadence.timeZone,
    });
  } catch (cause) {
    throw new AutomationScheduleError(
      "SCHEDULE_CADENCE_INVALID",
      `Invalid cron expression '${cadence.expression}'.`,
      { cause },
    );
  }
};

export const validateAutomationScheduleCadence = (cadence: AutomationScheduleCadence): void => {
  if (cadence.kind === "once") {
    if (Number.isNaN(new Date(cadence.at).getTime())) {
      throw new AutomationScheduleError(
        "SCHEDULE_CADENCE_INVALID",
        "Invalid one-time schedule timestamp.",
      );
    }
    return;
  }

  const cron = createCron(cadence);
  let nextOccurrence: Date | null;
  try {
    nextOccurrence = cron.nextRun(new Date("2000-01-01T00:00:00.000Z"));
  } catch (cause) {
    throw new AutomationScheduleError(
      "SCHEDULE_CADENCE_INVALID",
      `Cron expression '${cadence.expression}' could not calculate an occurrence.`,
      { cause },
    );
  }
  if (!nextOccurrence) {
    throw new AutomationScheduleError(
      "SCHEDULE_CADENCE_INVALID",
      `Cron expression '${cadence.expression}' has no possible occurrence.`,
    );
  }
};

export const automationScheduleCadencesEqual = (
  left: AutomationScheduleCadence,
  right: AutomationScheduleCadence,
) => {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "once" && right.kind === "once") {
    return left.at === right.at;
  }
  if (left.kind === "cron" && right.kind === "cron") {
    return left.expression === right.expression && left.timeZone === right.timeZone;
  }
  return false;
};

export const nextAutomationScheduleOccurrence = (
  cadence: AutomationScheduleCadence,
  after: Date,
): Date | null => {
  if (cadence.kind === "once") {
    const at = new Date(cadence.at);
    if (Number.isNaN(at.getTime())) {
      throw new AutomationScheduleError(
        "SCHEDULE_CADENCE_INVALID",
        "Invalid one-time schedule timestamp.",
      );
    }
    return at.getTime() > after.getTime() ? at : null;
  }

  return createCron(cadence).nextRun(after);
};
