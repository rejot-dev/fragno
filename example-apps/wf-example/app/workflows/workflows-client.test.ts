import { describe, it, assert } from "vitest";

import { workflowsClient } from "./workflows-client";

describe("workflows client helpers", () => {
  it("labels statuses", () => {
    assert(workflowsClient.helpers.statusLabel("active") === "Active");
  });

  it("detects terminal statuses", () => {
    assert(workflowsClient.helpers.isTerminalStatus("complete"));
    assert(workflowsClient.helpers.isTerminalStatus("errored"));
    assert(!workflowsClient.helpers.isTerminalStatus("active"));
  });

  it("detects waiting statuses", () => {
    assert(workflowsClient.helpers.isWaitingStatus("waiting"));
    assert(!workflowsClient.helpers.isWaitingStatus("active"));
  });
});
