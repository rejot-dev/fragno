import { describe, expect, it } from "vitest";

import superjson, { type SuperJSONResult } from "superjson";

import { parseOutboxStreamFrame } from "./outbox-stream";
import { assembleSerializedOutboxStreamEntry } from "./serialized-outbox-stream-entry";

describe("serialized outbox stream entry", () => {
  it("preserves operation JSON while prefixing only its compact SuperJSON metadata", () => {
    const operationJson =
      '{ "op": "create", "values": {"createdAt":"2026-09-25T00:00:00.000Z", "nested":{"items":[{"value":"kept"}]}} }';
    const mutationPayload =
      `{"json":${operationJson},` + '"meta":{"values":{"values.createdAt":["Date"]},"v":1}}';
    const entry = assembleSerializedOutboxStreamEntry({
      versionstamp: "000000000000000000000001",
      uowId: 'uow-"quoted"',
      refMapJson: '{"user:1":"external-1"}',
      mutationPayloadsJson: `[${mutationPayload}]`,
      mysqlOrdinalWrapped: false,
    });

    expect(entry.entryJson).toContain(`"operations":[${operationJson}]`);
    expect(
      parseOutboxStreamFrame(JSON.parse(`{"type":"entry","entry":${entry.entryJson}}`)),
    ).toEqual({
      type: "entry",
      entry: {
        versionstamp: "000000000000000000000001",
        uowId: 'uow-"quoted"',
        payload: {
          json: {
            version: 2,
            operations: [
              {
                op: "create",
                values: {
                  createdAt: "2026-09-25T00:00:00.000Z",
                  nested: { items: [{ value: "kept" }] },
                },
              },
            ],
          },
          meta: { values: { "operations.0.values.createdAt": ["Date"] }, v: 1 },
        },
        refMap: { "user:1": "external-1" },
      },
    });
  });

  it("composes independent special values and referential equalities across operations", () => {
    const shared = { label: "shared" };
    const operations = [
      {
        op: "create",
        values: {
          createdAt: new Date("2026-09-25T00:00:00.000Z"),
          amount: 42n,
          dotted: { "property.with.dots": new Set(["a", "b"]) },
        },
      },
      { op: "update", set: { first: shared, second: shared } },
    ];
    const mutationPayloadsJson = JSON.stringify(
      operations.map((operation) => superjson.serialize(operation)),
    );
    const entry = assembleSerializedOutboxStreamEntry({
      versionstamp: "000000000000000000000001",
      uowId: "uow-1",
      refMapJson: null,
      mutationPayloadsJson,
      mysqlOrdinalWrapped: false,
    });
    const payload = (JSON.parse(entry.entryJson) as { payload: SuperJSONResult }).payload;
    const decoded = superjson.deserialize<{ operations: typeof operations }>(payload);

    expect(decoded.operations).toEqual(operations);
    const updateSet = (decoded.operations[1] as { set: { first: unknown; second: unknown } }).set;
    expect(updateSet.first).toBe(updateSet.second);
  });

  it("restores MySQL mutation order without interpreting operation payloads", () => {
    const entry = assembleSerializedOutboxStreamEntry({
      versionstamp: "000000000000000000000001",
      uowId: "uow-1",
      refMapJson: null,
      mutationPayloadsJson:
        '[[2,{"json":{"op":"delete","externalId":"second"}}],[1,{"json":{"op":"delete","externalId":"first"}}]]',
      mysqlOrdinalWrapped: true,
    });

    expect(JSON.parse(entry.entryJson)).toMatchObject({
      payload: {
        json: {
          operations: [{ externalId: "first" }, { externalId: "second" }],
        },
      },
    });
  });

  it("omits a null reference map from an empty wire entry", () => {
    const entry = assembleSerializedOutboxStreamEntry({
      versionstamp: "000000000000000000000001",
      uowId: "uow-1",
      refMapJson: null,
      mutationPayloadsJson: "[]",
      mysqlOrdinalWrapped: false,
    });

    expect(entry.entryJson).not.toContain("refMap");
    expect(JSON.parse(entry.entryJson)).toMatchObject({
      payload: { json: { version: 2, operations: [] } },
    });
  });
});
