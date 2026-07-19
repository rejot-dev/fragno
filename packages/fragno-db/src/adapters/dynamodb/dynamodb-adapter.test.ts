import { describe, expect, it } from "vitest";

import { suffixNamingStrategy } from "../../naming/sql-naming";
import { column, FragnoId, idColumn, schema } from "../../schema/create";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "../adapters";
import { DynamoDBAdapter } from "./dynamodb-adapter";
import type { DynamoDBCommandPlan } from "./dynamodb-uow-operation-compiler";
import {
  DynamoDBItemSizeError,
  DynamoDBReadLimitError,
  DynamoDBTransactionLimitError,
  DynamoDBUnsupportedQueryError,
} from "./errors";

const testSchema = schema("shop", (s) =>
  s.addTable("orders", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("status", column("string"))
      .addColumn("total", column("integer"))
      .createIndex("byStatus", ["status"]),
  ),
);

const createAdapter = (plans: DynamoDBCommandPlan[] = []) =>
  new DynamoDBAdapter({
    client: { send: async () => ({}) } as never,
    tablePrefix: "fragno",
    uowConfig: {
      dryRun: true,
      onCommand: (plan) => plans.push(plan),
    },
  });

const createExecutingAdapter = (
  options: {
    send?: (command: object) => Promise<unknown>;
    allowScans?: boolean;
    maxFilteredReadPages?: number;
  } = {},
) =>
  new DynamoDBAdapter({
    client: {
      send: options.send ?? (async () => ({})),
    } as never,
    tablePrefix: "fragno",
    allowScans: options.allowScans,
    maxFilteredReadPages: options.maxFilteredReadPages,
  });

describe("DynamoDBAdapter", () => {
  it("exposes adapter identity", () => {
    const adapter = createAdapter();

    expect(adapter[fragnoDatabaseAdapterNameFakeSymbol]).toBe("dynamodb");
    expect(adapter[fragnoDatabaseAdapterVersionFakeSymbol]).toBe(1);
  });

  it("createUnitOfWork compiles find and count plans", async () => {
    const plans: DynamoDBCommandPlan[] = [];
    const adapter = createAdapter(plans);

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) =>
      b.whereIndex("byStatus", (eb) => eb("status", "=", "open")).orderByIndex("byStatus", "asc"),
    );
    uow.find("orders", (b) => b.whereIndex("byStatus").selectCount());

    await uow.executeRetrieve();

    expect(plans.map((plan) => plan.kind)).toEqual(["find", "count"]);
    expect(plans[0]).toMatchObject({
      kind: "find",
      schemaName: "shop",
      namespace: "shop",
      tableName: "orders",
      indexName: "byStatus",
      layout: {
        baseTableName: "fragno__shop__orders",
        indexTableName: "fragno__shop__orders__idx",
      },
    });
  });

  it("createBaseUnitOfWork compiles create, update, delete, and check plans", async () => {
    const plans: DynamoDBCommandPlan[] = [];
    const adapter = createAdapter(plans);
    adapter.registerSchema(testSchema, "shop");

    const uow = adapter.createBaseUnitOfWork().forSchema(testSchema);
    const id = uow.create("orders", { id: "order_1", status: "open", total: 10 });
    const persistedId = new FragnoId({ externalId: id.externalId, internalId: 1n, version: 0 });
    uow.update("orders", persistedId, (b) => b.set({ total: 20 }).check());
    uow.check("orders", persistedId);
    uow.delete("orders", persistedId, (b) => b.check());

    await uow.executeMutations();

    expect(plans.map((plan) => plan.kind)).toEqual(["create", "update", "check", "delete"]);
    expect(plans[0]).toMatchObject({
      kind: "create",
      externalId: "order_1",
      item: { id: "order_1", status: "open", total: 10 },
    });
    expect(plans[1]).toMatchObject({ kind: "update", externalId: "order_1", expectedVersion: 0 });
    expect(plans[2]).toMatchObject({ kind: "check", externalId: "order_1", expectedVersion: 0 });
    expect(plans[3]).toMatchObject({ kind: "delete", externalId: "order_1", expectedVersion: 0 });
  });

  it("throws DynamoDBTransactionLimitError before sending oversized transactions", async () => {
    const sentCommands: string[] = [];
    const adapter = createExecutingAdapter({
      send: async (command) => {
        sentCommands.push(command.constructor.name);
        return {};
      },
    });

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    for (let index = 0; index < 34; index += 1) {
      uow.create("orders", { id: `order_limit_${index}`, status: "open", total: index });
    }

    await expect(uow.executeMutations()).rejects.toBeInstanceOf(DynamoDBTransactionLimitError);
    expect(sentCommands).not.toContain("TransactWriteCommand");
  });

  it("throws DynamoDBItemSizeError for oversized items before sending the transaction", async () => {
    const sentCommands: string[] = [];
    const adapter = createExecutingAdapter({
      send: async (command) => {
        sentCommands.push(command.constructor.name);
        return {};
      },
    });

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.create("orders", { id: "order_oversized", status: "x".repeat(410 * 1024), total: 1 });

    await expect(uow.executeMutations()).rejects.toBeInstanceOf(DynamoDBItemSizeError);
    expect(sentCommands).not.toContain("TransactWriteCommand");
  });

  it("pushes leading equality predicates into the DynamoDB sort-key condition", async () => {
    const queryInputs: Record<string, unknown>[] = [];
    const adapter = createExecutingAdapter({
      send: async (command) => {
        if (command.constructor.name === "QueryCommand") {
          queryInputs.push((command as { input: Record<string, unknown> }).input);
          return { Items: [] };
        }
        return {};
      },
    });

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) => b.whereIndex("byStatus", (eb) => eb("status", "=", "open")));

    await expect(uow.executeRetrieve()).resolves.toEqual([[]]);
    expect(queryInputs[0]).toMatchObject({
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
      ExpressionAttributeValues: expect.objectContaining({ ":pk": "idx#byStatus" }),
    });
  });

  it("retries BatchGet unprocessed keys before returning query rows", async () => {
    let batchGetCalls = 0;
    const adapter = createExecutingAdapter({
      send: async (command) => {
        if (command.constructor.name === "QueryCommand") {
          return {
            Items: [{ externalId: "order_batch_1" }, { externalId: "order_batch_2" }],
          };
        }
        if (command.constructor.name === "BatchGetCommand") {
          batchGetCalls += 1;
          if (batchGetCalls === 1) {
            return {
              Responses: {
                fragno__shop__orders: [
                  {
                    pk: "order_batch_1",
                    id: "order_batch_1",
                    status: "open",
                    total: 1,
                    _internalId: "1",
                    _version: 0,
                  },
                ],
              },
              UnprocessedKeys: {
                fragno__shop__orders: { Keys: [{ pk: "order_batch_2" }] },
              },
            };
          }
          return {
            Responses: {
              fragno__shop__orders: [
                {
                  pk: "order_batch_2",
                  id: "order_batch_2",
                  status: "open",
                  total: 2,
                  _internalId: "2",
                  _version: 0,
                },
              ],
            },
          };
        }
        return {};
      },
    });

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) => b.whereIndex("byStatus", (eb) => eb("status", "=", "open")));

    await uow.executeRetrieve();
    const [orders] = (await uow.retrievalPhase) as unknown as [{ id: FragnoId }[]];
    expect(orders.map((order) => order.id.externalId)).toEqual(["order_batch_1", "order_batch_2"]);
    expect(batchGetCalls).toBe(2);
  });

  it("uses the configured naming strategy when compiling UOW plans", async () => {
    const plans: DynamoDBCommandPlan[] = [];
    const adapter = new DynamoDBAdapter({
      client: { send: async () => ({}) } as never,
      tablePrefix: "fragno",
      namingStrategy: {
        ...suffixNamingStrategy,
        tableName: (logicalTable) => `custom_${logicalTable}`,
      },
      uowConfig: {
        dryRun: true,
        onCommand: (plan) => plans.push(plan),
      },
    });

    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) => b.whereIndex("byStatus", (eb) => eb("status", "=", "open")));
    await uow.executeRetrieve();

    expect(plans[0]?.layout.baseTableName).toBe("fragno__shop__custom_orders");
  });

  it("throws DynamoDBUnsupportedQueryError for unbounded index reads unless scans are enabled", async () => {
    const adapter = createExecutingAdapter();
    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) => b.whereIndex("byStatus"));

    await expect(uow.executeRetrieve()).rejects.toBeInstanceOf(DynamoDBUnsupportedQueryError);

    const scanAdapter = createExecutingAdapter({
      allowScans: true,
      send: async () => ({ Items: [] }),
    });
    const scanUow = scanAdapter.createUnitOfWork(testSchema, "shop");
    scanUow.find("orders", (b) => b.whereIndex("byStatus"));

    await expect(scanUow.executeRetrieve()).resolves.toEqual([[]]);
  });

  it("throws DynamoDBReadLimitError when filtered reads exceed maxFilteredReadPages", async () => {
    const adapter = createExecutingAdapter({
      maxFilteredReadPages: 1,
      send: async () => ({ Items: [], LastEvaluatedKey: { pk: "idx#byStatus", sk: "next" } }),
    });
    const uow = adapter.createUnitOfWork(testSchema, "shop");
    uow.find("orders", (b) => b.whereIndex("byStatus", (eb) => eb("status", "=", "open")));

    await expect(uow.executeRetrieve()).rejects.toBeInstanceOf(DynamoDBReadLimitError);
  });
});
