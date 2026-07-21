import { describe, expect, it } from "vitest";

import superjson from "superjson";

import { parseOutboxStreamEntry } from "./outbox";

const validEntry = () => ({
  id: { externalId: "outbox-1", internalId: "1" },
  versionstamp: "000000000000000000000001",
  uowId: "uow-1",
  payload: superjson.serialize({
    version: 1,
    mutations: [
      {
        op: "create",
        schema: "app",
        schemaName: "app",
        namespace: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "000000000000000000000001",
        values: { name: "Ada", createdAt: new Date("2026-07-17T10:00:00.000Z") },
      },
    ],
  }),
  refMap: { "0.owner": "user-1" },
  createdAt: "2026-07-17T10:00:00.000Z",
});

describe("parseOutboxStreamEntry", () => {
  it("establishes the complete Durable Streams wire contract", () => {
    const entry = parseOutboxStreamEntry(validEntry());

    expect(entry).toEqual({
      id: { externalId: "outbox-1", internalId: "1" },
      versionstamp: "000000000000000000000001",
      uowId: "uow-1",
      payload: {
        version: 1,
        mutations: [
          {
            op: "create",
            schema: "app",
            schemaName: "app",
            namespace: "app",
            table: "users",
            externalId: "user-1",
            versionstamp: "000000000000000000000001",
            values: { name: "Ada", createdAt: new Date("2026-07-17T10:00:00.000Z") },
          },
        ],
      },
      refMap: { "0.owner": "user-1" },
      createdAt: new Date("2026-07-17T10:00:00.000Z"),
    });
  });

  it.each([
    ["entry", null],
    ["entry versionstamp", { ...validEntry(), versionstamp: "1" }],
    [
      "mutation operation",
      {
        ...validEntry(),
        payload: superjson.serialize({
          version: 1,
          mutations: [{ op: "replace" }],
        }),
      },
    ],
    ["reference map", { ...validEntry(), refMap: { owner: 42 } }],
    ["creation timestamp", { ...validEntry(), createdAt: "not-a-date" }],
  ])("rejects an invalid %s", (_name, value) => {
    expect(() => parseOutboxStreamEntry(value)).toThrow("Invalid Fragno outbox stream entry");
  });
});
