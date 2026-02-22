import { describe, expect, it } from "vitest";

import { workflowsClient } from "./workflows-client";

describe("workflows client helpers", () => {
  it("labels statuses", () => {
    expect(workflowsClient.helpers.statusLabel("active")).toBe("Active");
  });

  it("detects terminal statuses", () => {
    expect(workflowsClient.helpers.isTerminalStatus("complete")).toBe(true);
    expect(workflowsClient.helpers.isTerminalStatus("errored")).toBe(true);
    expect(workflowsClient.helpers.isTerminalStatus("active")).toBe(false);
  });

  it("detects waiting statuses", () => {
    expect(workflowsClient.helpers.isWaitingStatus("waiting")).toBe(true);
    expect(workflowsClient.helpers.isWaitingStatus("active")).toBe(false);
  });
});
