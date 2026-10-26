import type { DurableHookAttempt, DurableHookAttemptOutcome } from "@fragno-dev/db/hooks";

import type { BackofficeObjectScope } from "./object-registry";

/** The object whose runtime reported a signal. */
export type BackofficeTelemetryObject = {
  /** The hosted Fragment runtime, such as `Automations`. */
  host: string;
  /** Null for objects that no registry address names, such as Pi agents. */
  scope: BackofficeObjectScope | null;
};

/** An operational fact Backoffice reports for monitoring, alongside its traces and logs. */
export type BackofficeTelemetrySignal = {
  kind: "durable-hook-attempt";
  object: BackofficeTelemetryObject;
  attempt: DurableHookAttempt;
  outcome: DurableHookAttemptOutcome;
};

/** Delivery is best-effort: recording never throws and never changes the outcome it describes. */
export type BackofficeTelemetry = {
  record(signal: BackofficeTelemetrySignal): void;
};

/** For runtimes that report nowhere, such as Node deployments. */
export const discardBackofficeTelemetry: BackofficeTelemetry = {
  record() {},
};
