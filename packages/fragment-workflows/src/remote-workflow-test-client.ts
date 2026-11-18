import type { RemoteWorkflowStepHost, RemoteWorkflowWaitForEventOptions } from "./remote-workflow";
import type { WorkflowDuration, WorkflowStepConfig, WorkflowStepTx } from "./workflow";
import { createWorkflowTick, type WorkflowStepCallOutcome } from "./workflow-tick";

type RemoteTestStep = {
  do<T>(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: RemoteWorkflowWaitForEventOptions<T>,
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
};

/**
 * Runs workflow code against a remote host the way a remote realm does: under its own tick, which
 * reports the tick idle when the code stops without settling. `deliver` stands in for the transport
 * between the realms, such as to hold a step's outcome back.
 */
export async function runRemotely<T>(
  remote: RemoteWorkflowStepHost,
  body: (step: RemoteTestStep) => Promise<T>,
  deliver: (name: string, outcome: WorkflowStepCallOutcome) => Promise<WorkflowStepCallOutcome> = (
    _name,
    outcome,
  ) => Promise.resolve(outcome),
): Promise<T> {
  const tick = createWorkflowTick(remote.settledOrders);
  // Each outcome is the one its own call settled with.
  const call = async <R>(name: string, start: () => Promise<WorkflowStepCallOutcome<R>>) =>
    (await tick.call(async () => await deliver(name, await start()))) as R;
  const step: RemoteTestStep = {
    do: (name, config, callback) => call(name, () => remote.do(name, config, callback)),
    sleep: (name, duration) => call(name, () => remote.sleep(name, duration)),
    waitForEvent: (name, options) => call(name, () => remote.waitForEvent(name, options)),
  };
  const end = await tick.run(() => body(step));
  if (end.type === "returned") {
    // The body's own return value.
    return end.value as T;
  }
  if (end.type === "threw") {
    throw end.error;
  }
  return remote.reportIdle();
}
