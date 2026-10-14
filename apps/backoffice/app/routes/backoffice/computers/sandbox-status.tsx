import { ClientOnly } from "@fragno-private/design-system/client-only";
import {
  BackofficeStatusLight,
  type BackofficeStatusTone,
} from "@fragno-private/design-system/status-light";

import type { SandboxInstanceStatus } from "@/sandbox/contracts";

import type { SandboxView } from "./sandbox-model";

const STATUS_LABELS: Record<SandboxInstanceStatus, string> = {
  requested: "Requested",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
};

const STATUS_TONES: Record<SandboxInstanceStatus, BackofficeStatusTone> = {
  requested: "waiting",
  starting: "waiting",
  running: "live",
  stopping: "waiting",
  stopped: "muted",
  error: "failed",
};

export function SandboxStatusLight({ status }: { status: SandboxInstanceStatus }) {
  return (
    <BackofficeStatusLight tone={STATUS_TONES[status]}>
      {STATUS_LABELS[status]}
    </BackofficeStatusLight>
  );
}

export function isSandboxStatusTransitional(status: SandboxInstanceStatus) {
  return status === "requested" || status === "starting" || status === "stopping";
}

/** What the sandbox is doing over time: when it sleeps, or how long it has been stopped. */
export function SandboxActivity({ sandbox }: { sandbox: SandboxView }) {
  const { status } = sandbox;
  if (status === "requested" || status === "starting") {
    return "Starting…";
  }
  if (status === "stopping") {
    return "Saving workspace…";
  }
  if (status === "running") {
    if (sandbox.keepAlive) {
      return "Keep-alive";
    }
    return sandbox.expectedStopAt ? (
      <>
        Sleeps <RelativeTime date={sandbox.expectedStopAt} />
      </>
    ) : (
      "Running"
    );
  }
  if (status === "stopped") {
    return sandbox.stoppedAt ? (
      <>
        Stopped <RelativeTime date={sandbox.stoppedAt} />
      </>
    ) : (
      "Stopped"
    );
  }
  return sandbox.lastError ?? "Failed";
}

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_TIME_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", Number.POSITIVE_INFINITY],
];

// Rendered on the client only: the server's clock and time zone would not match the browser's.
export function RelativeTime({ date }: { date: Date }) {
  return (
    <ClientOnly fallback={<time dateTime={date.toISOString()}>…</time>}>
      {() => (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {formatRelativeTime(date, Date.now())}
        </time>
      )}
    </ClientOnly>
  );
}

function formatRelativeTime(date: Date, now: number): string {
  let value = (date.getTime() - now) / 1000;
  for (const [unit, size] of RELATIVE_TIME_STEPS) {
    if (Math.abs(value) < size) {
      return relativeTimeFormat.format(Math.round(value), unit);
    }
    value /= size;
  }
  throw new Error("Relative time steps end with an unbounded unit.");
}
