import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
import { z } from "zod";

/** How each status a workflow run can be in reads, wherever a run's status shows. */
export const RUN_STATUS_LIGHTS = {
  active: { label: "Running", tone: "info" },
  paused: { label: "Paused", tone: "waiting" },
  waiting: { label: "Waiting", tone: "waiting" },
  complete: { label: "Complete", tone: "live" },
  errored: { label: "Errored", tone: "failed" },
  terminated: { label: "Terminated", tone: "muted" },
} as const satisfies Record<WorkflowInstanceStatus, { label: string; tone: BackofficeStatusTone }>;

export const RUN_STATUSES = Object.keys(RUN_STATUS_LIGHTS) as [
  WorkflowInstanceStatus,
  ...WorkflowInstanceStatus[],
];

export const runStatusDefinition = {
  props: z.strictObject({ status: z.enum(RUN_STATUSES) }),
  slots: [],
  description:
    "A workflow run's status as the dashboard shows it: Running, Paused, Waiting, Complete, Errored, or Terminated, each in its tone. Pass a run's status field as it is.",
  example: { status: "complete" },
};
