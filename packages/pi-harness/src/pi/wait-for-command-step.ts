import { buildStepKey } from "@fragno-dev/workflows/step-identity";

import type { DatabaseHandlerTx } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { PI_SESSION_COMMAND_STEP_PREFIX } from "./types";

const COMMAND_STEP_POLL_INTERVAL_MS = 100;

export class CommandStepWaitTimeoutError extends Error {
  constructor(workflowName: string, instanceId: string, commandId: string) {
    super(`Timed out waiting for command ${commandId} in ${workflowName}/${instanceId}.`);
    this.name = "CommandStepWaitTimeoutError";
  }
}

export class CommandStepFailedError extends Error {
  constructor(commandId: string, error: { name: string; message: string }) {
    super(`Command ${commandId} failed: ${error.name}: ${error.message}`);
    this.name = "CommandStepFailedError";
  }
}

export class CommandWorkflowTerminatedError extends Error {
  constructor(commandId: string, status: string) {
    super(`Command ${commandId} could not complete: workflow is ${status}.`);
    this.name = "CommandWorkflowTerminatedError";
  }
}

export async function waitForCommandStep(options: {
  handlerTx: DatabaseHandlerTx;
  workflows: WorkflowsFragmentServices;
  workflowName: string;
  instanceId: string;
  commandId: string;
  timeoutMs: number;
}): Promise<void> {
  const { handlerTx, workflows, workflowName, instanceId, commandId } = options;
  const stepKey = buildStepKey("do", `${PI_SESSION_COMMAND_STEP_PREFIX}${commandId}`);
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    const outcome = await handlerTx()
      .withServiceCalls(
        () => [workflows.getStepOutcome(workflowName, instanceId, stepKey)] as const,
      )
      .transform(({ serviceResult: [result] }) => result)
      .execute();

    switch (outcome.status) {
      case "completed":
        return;
      case "errored":
        throw new CommandStepFailedError(commandId, outcome.error);
      case "instance-terminal":
        throw new CommandWorkflowTerminatedError(commandId, outcome.instanceStatus);
      case "not-started":
      case "waiting":
        break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CommandStepWaitTimeoutError(workflowName, instanceId, commandId);
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, Math.min(COMMAND_STEP_POLL_INTERVAL_MS, remainingMs));
      timeout.unref?.();
    });
  }
}
