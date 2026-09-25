import { describe, expect, it } from "vitest";

import { parseOutboxStreamFrame } from "./outbox-stream";

const started = {
  type: "started",
  protocolVersion: 1,
  adapterIdentity: "source",
  catchUpTargetVersionstamp: null,
  catchUpPageSize: 50,
};
const entry = {
  type: "entry",
  entry: {
    id: "entry-id",
    createdAt: "2026-09-25T00:00:00.000Z",
    versionstamp: "000000000000000000000000",
    uowId: "unit-of-work",
    payload: { json: { version: 2, operations: [] }, meta: {} },
    refMap: { "ref:1": "row" },
  },
};

describe("outbox stream protocol boundary", () => {
  it("keeps the complete entry and opaque payload without reconstructing them", () => {
    expect(parseOutboxStreamFrame(entry)).toBe(entry);
  });

  it.each([
    null,
    {},
    { ...started, protocolVersion: 2 },
    { ...started, adapterIdentity: "" },
    { ...started, catchUpTargetVersionstamp: undefined },
    { ...started, catchUpPageSize: 0 },
    { ...started, catchUpPageSize: 51 },
    { ...started, catchUpPageSize: 1.5 },
    { ...entry, entry: { ...entry.entry, versionstamp: "invalid" } },
    { ...entry, entry: { ...entry.entry, refMap: { key: 5 } } },
    { type: "caught-up" },
    { type: "rotate", reason: "unknown" },
    { type: "future-frame" },
  ])("rejects invalid wire data %j", (value) => {
    expect(() => parseOutboxStreamFrame(value)).toThrow("Invalid Fragno outbox stream frame");
  });
});
