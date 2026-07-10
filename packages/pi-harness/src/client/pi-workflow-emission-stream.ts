import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { LofiEphemeralTable } from "@fragno-dev/lofi";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const streamKey = (values: Record<string, unknown>): string => {
  const { instanceRef, stepKey, epoch } = values;
  if (instanceRef === undefined || typeof stepKey !== "string" || typeof epoch !== "string") {
    throw new Error("Pi workflow emission is missing its stream identity.");
  }
  return `${String(instanceRef)}:${stepKey}:${epoch}`;
};

const streamBoundary = (values: Record<string, unknown>): "start" | "item" | "end" => {
  const payload = values["payload"];
  if (!isRecord(payload)) {
    return "item";
  }

  const replay = payload["replay"];
  if (
    payload["kind"] === "harness-operation-start" &&
    isRecord(replay) &&
    replay["protocol"] === "pi-harness-operation" &&
    replay["version"] === 1
  ) {
    return "start";
  }

  return payload["control"] === "step-committed" ? "end" : "item";
};

/** Recoverable Pi operation streams backed by workflow step commit boundaries. */
export const piWorkflowStepEmissionEphemeralTable = {
  schema: workflowsSchema.name,
  table: "workflow_step_emission",
  stream: {
    key: streamKey,
    boundary: streamBoundary,
  },
} satisfies LofiEphemeralTable;
