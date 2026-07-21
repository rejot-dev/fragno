import { describe, expect, it, assert } from "vitest";

import type { ProtocolEnvelope } from "@tanstack/db-sqlite-persistence-core";

import {
  createTerminalErrorMessage,
  parseCommittedCheckpoint,
  parseHeartbeatLeaderId,
  parseTerminalError,
} from "./coordinator-messages";

const envelope = (payload: unknown): ProtocolEnvelope<unknown> => ({
  v: 1,
  dbName: "stream-db",
  collectionId: "stream-db",
  senderId: "leader-1",
  ts: Date.now(),
  payload,
});

describe("coordinator messages", () => {
  it("encodes and parses versioned terminal errors", () => {
    const payload = createTerminalErrorMessage({
      ownerId: "leader-1",
      offset: "0000000000000000000000001",
      error: new TypeError("stream failed"),
    });

    assert(payload.version === 1);
    expect(parseTerminalError(envelope(payload))).toMatchObject({
      ownerId: "leader-1",
      offset: "0000000000000000000000001",
      error: { name: "TypeError", message: "stream failed" },
    });
    expect(parseTerminalError(envelope({ ...payload, version: 2 }))).toBeUndefined();
  });

  it("parses leader heartbeats", () => {
    assert(
      parseHeartbeatLeaderId(envelope({ type: "leader:heartbeat", leaderId: "leader-2" })) ===
        "leader-2",
    );
  });

  it("extracts committed source checkpoints", () => {
    expect(
      parseCommittedCheckpoint(
        envelope({
          type: "tx:committed",
          requiresFullReload: false,
          changedRows: [
            {
              value: {
                id: "fragno:checkpoint",
                tableKey: "fragno:<checkpoint>",
                checkpoint: {
                  offset: "0000000000000000000000002",
                  cacheVersion: 1,
                  ownerId: "leader-1",
                  generation: "leader-1:2",
                  upToDate: true,
                },
              },
            },
          ],
        }),
      ),
    ).toEqual({
      offset: "0000000000000000000000002",
      cacheVersion: 1,
      ownerId: "leader-1",
      generation: "leader-1:2",
      upToDate: true,
    });
  });
});
