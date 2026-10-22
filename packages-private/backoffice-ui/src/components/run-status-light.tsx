import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";

import { RUN_STATUS_LIGHTS } from "./run-status";

/** A workflow run's status, as the dashboard and pages show it. */
export function RunStatusLight({ status }: { status: WorkflowInstanceStatus }) {
  const light = RUN_STATUS_LIGHTS[status];
  return (
    <BackofficeStatusLight tone={light.tone} dot={false}>
      {light.label}
    </BackofficeStatusLight>
  );
}
