import { describe, expect, it } from "vitest";

import { TransactionIdTracker } from "./transaction-id-tracker";

describe("TransactionIdTracker", () => {
  it("resolves current and future waiters when a transaction is observed", async () => {
    const tracker = new TransactionIdTracker();
    const future = tracker.waitFor("tx-1");

    tracker.observe(["tx-1"]);

    await expect(future).resolves.toBeUndefined();
    await expect(tracker.waitFor("tx-1")).resolves.toBeUndefined();
  });

  it("times out a transaction without affecting later observations", async () => {
    const tracker = new TransactionIdTracker();

    await expect(tracker.waitFor("tx-1", 0)).rejects.toThrow(
      "Timed out waiting for transaction tx-1",
    );
    tracker.observe(["tx-1"]);
    await expect(tracker.waitFor("tx-1")).resolves.toBeUndefined();
  });

  it("rejects all pending waiters on terminal lifecycle transitions", async () => {
    const tracker = new TransactionIdTracker();
    const first = tracker.waitFor("tx-1");
    const second = tracker.waitFor("tx-2");

    tracker.rejectAll(new Error("stream closed"));

    await expect(first).rejects.toThrow("stream closed");
    await expect(second).rejects.toThrow("stream closed");
  });

  it("validates transaction IDs and timeout values", async () => {
    const tracker = new TransactionIdTracker();

    await expect(tracker.waitFor("")).rejects.toThrow("non-empty transaction ID");
    await expect(tracker.waitFor("tx-1", -1)).rejects.toThrow("non-negative number");
  });
});
