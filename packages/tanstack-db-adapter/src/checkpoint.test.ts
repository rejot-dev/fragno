import { assert, describe, expect, it } from "vitest";

import { checkpointForEntry, shouldApplyOutboxEntry } from "./checkpoint";
import type { FragnoOutboxEntry } from "./protocol";

function entry(versionstamp: string, uowId: string): FragnoOutboxEntry {
  return {
    versionstamp,
    uowId,
    payload: { json: { version: 1, mutations: [] } },
  };
}

describe("Fragno outbox checkpoints", () => {
  it("creates a checkpoint from the ordered entry identity", () => {
    expect(checkpointForEntry(entry("000000000000000000000001", "uow-1"))).toEqual({
      versionstamp: "000000000000000000000001",
      uowId: "uow-1",
    });
  });

  it("applies entries newer than the collection checkpoint", () => {
    assert(
      shouldApplyOutboxEntry(
        { versionstamp: "000000000000000000000001", uowId: "uow-1" },
        entry("000000000000000000000002", "uow-2"),
      ),
    );
  });

  it("skips stale and exact entry replays", () => {
    const checkpoint = {
      versionstamp: "000000000000000000000002",
      uowId: "uow-2",
    };

    assert(!shouldApplyOutboxEntry(checkpoint, entry("000000000000000000000001", "uow-1")));
    assert(!shouldApplyOutboxEntry(checkpoint, entry(checkpoint.versionstamp, checkpoint.uowId)));
  });

  it("rejects a changed UOW identity at the same versionstamp", () => {
    expect(() =>
      shouldApplyOutboxEntry(
        { versionstamp: "000000000000000000000001", uowId: "uow-original" },
        entry("000000000000000000000001", "uow-changed"),
      ),
    ).toThrow(
      "Outbox versionstamp 000000000000000000000001 changed from UOW uow-original to uow-changed.",
    );
  });
});
