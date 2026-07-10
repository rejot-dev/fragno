import { describe, it, assert } from "vitest";

import { piWorkflowStepEmissionEphemeralTable } from "./pi-workflow-emission-stream";

describe("piWorkflowStepEmissionEphemeralTable", () => {
  it("keys replay streams by workflow step attempt", () => {
    assert(
      piWorkflowStepEmissionEphemeralTable.stream.key({
        instanceRef: "instance-a",
        stepKey: "prompt",
        epoch: "epoch-2",
      }) === "instance-a:prompt:epoch-2",
    );
  });

  it("uses operation start and step commit as replay boundaries", () => {
    const boundary = piWorkflowStepEmissionEphemeralTable.stream.boundary;

    assert(
      boundary({
        payload: {
          kind: "harness-operation-start",
          replay: { protocol: "pi-harness-operation", version: 1 },
        },
      }) === "start",
    );
    assert(boundary({ payload: { kind: "harness-message-update" } }) === "item");
    assert(boundary({ payload: { control: "step-committed" } }) === "end");
  });
});
