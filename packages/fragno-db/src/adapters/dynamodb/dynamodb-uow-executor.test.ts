import { expect, it } from "vitest";

import { column, FragnoId, idColumn, schema } from "../../schema/create";
import { DynamoDBAdapter } from "./dynamodb-adapter";
import { describeDynamoDBLocal, getDynamoDBLocalTestContext } from "./test-utils";

const executorSchema = schema("shop", (s) =>
  s.addTable("orders", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("status", column("string"))
      .addColumn("total", column("integer")),
  ),
);

describeDynamoDBLocal("DynamoDB UOW executor", () => {
  it("creates a row and finds it through the primary sidecar index", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const adapter = new DynamoDBAdapter({
      client: context!.client,
      tablePrefix: context!.tablePrefix,
    });
    await adapter.prepareMigrations(executorSchema, "shop").execute(0);

    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_1", status: "open", total: 100 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const [createdId] = createUow.getCreatedIds();
    expect(createdId).toBeInstanceOf(FragnoId);
    expect(createdId?.externalId).toBe("order_1");
    expect(createdId?.internalId).toBe(1n);
    expect(createdId?.version).toBe(0);

    const findUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withFind = findUow.find("orders", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", "order_1")),
    );
    const [orders] = await withFind.executeRetrieve();

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: "open", total: 100 });
    expect(orders[0]?.id).toBeInstanceOf(FragnoId);
    expect(orders[0]?.id.externalId).toBe("order_1");
    expect(orders[0]?.id.internalId).toBe(1n);
    expect(orders[0]?.id.version).toBe(0);
  });

  it("returns created IDs in create operation order", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const adapter = new DynamoDBAdapter({
      client: context!.client,
      tablePrefix: context!.tablePrefix,
    });
    await adapter.prepareMigrations(executorSchema, "shop").execute(0);

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.create("orders", { id: "order_a", status: "open", total: 1 });
    uow.create("orders", { id: "order_b", status: "paid", total: 2 });
    uow.create("orders", { id: "order_c", status: "closed", total: 3 });

    await expect(uow.executeMutations()).resolves.toEqual({ success: true });

    expect(uow.getCreatedIds().map((id) => [id.externalId, id.internalId, id.version])).toEqual([
      ["order_a", 1n, 0],
      ["order_b", 2n, 0],
      ["order_c", 3n, 0],
    ]);
  });

  it("throws on duplicate external IDs", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const adapter = new DynamoDBAdapter({
      client: context!.client,
      tablePrefix: context!.tablePrefix,
    });
    await adapter.prepareMigrations(executorSchema, "shop").execute(0);

    const first = adapter.createUnitOfWork(executorSchema, "shop");
    first.create("orders", { id: "order_duplicate", status: "open", total: 1 });
    await expect(first.executeMutations()).resolves.toEqual({ success: true });

    const second = adapter.createUnitOfWork(executorSchema, "shop");
    second.create("orders", { id: "order_duplicate", status: "paid", total: 2 });
    await expect(second.executeMutations()).rejects.toThrow();
  });
});
