import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import type { CompactionResult, Harness, TaskId } from "@earendil-works/pi-durable";

import type { PiAgentCompactionStatus } from "./pi-agent-contract";

/** Reads a manual compaction as public state, hiding Pi's durable checkpoints and task inputs. */
export async function readPiCompactionStatus(
  harness: Harness,
  taskId: number,
): Promise<PiAgentCompactionStatus | null> {
  const task = await harness.getTask(taskId as TaskId<CompactionResult>, BACKGROUND_CONTEXT);
  if (task?.kind !== "pi.compaction") {
    return null;
  }
  if (task.state.status !== "completing" && task.state.status !== "terminal") {
    return { taskId, status: "running", message: null };
  }
  const outcome = task.state.outcome;
  if (outcome.status === "completed") {
    return outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined
      ? { taskId, status: "completed", message: null }
      : {
          taskId,
          status: "unchanged",
          message: "Pi context did not need compaction.",
        };
  }
  const message =
    outcome.status === "failed" || outcome.status === "faulted"
      ? outcome.error.message
      : (outcome.reason ?? `Pi compaction ${outcome.status}.`);
  return { taskId, status: "failed", message };
}
