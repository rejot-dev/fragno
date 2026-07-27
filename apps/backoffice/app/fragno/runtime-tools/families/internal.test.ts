import { describe, expect, test } from "vitest";

import type { MarketplaceStaticPublicationResult } from "@/fragno/marketplace/contracts";

import { formatMarketplacePushOutput } from "./internal";

const failedPublication: MarketplaceStaticPublicationResult = {
  publications: [
    {
      listingId: "system#telegram-test-command",
      slug: "telegram-test-command",
      version: "1.0.0",
      workflowInstanceId: "marketplace-publish-failed",
      state: "failed",
      workflowStatus: "errored",
      error: {
        name: "NonRetryableError",
        message: "Static marketplace publication failed.",
      },
    },
  ],
};

describe("formatMarketplacePushOutput", () => {
  test("prints terminal workflow failures and exits unsuccessfully", () => {
    expect(formatMarketplacePushOutput(failedPublication, { format: "text" })).toEqual({
      stdout: "failed\tsystem#telegram-test-command@1.0.0\tmarketplace-publish-failed\n",
      stderr:
        "system#telegram-test-command@1.0.0: NonRetryableError: Static marketplace publication failed.\n",
      exitCode: 1,
    });
  });

  test("retains structured failed results with a non-zero JSON exit code", () => {
    expect(formatMarketplacePushOutput(failedPublication, { format: "json" })).toEqual({
      data: failedPublication,
      exitCode: 1,
    });
  });
});
