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

async function createMigratedAdapter() {
  const context = getDynamoDBLocalTestContext();
  expect(context).not.toBeNull();
  const adapter = new DynamoDBAdapter({
    client: context!.client,
    tablePrefix: context!.tablePrefix,
  });
  await adapter.prepareMigrations(executorSchema, "shop").execute(0);
  return adapter;
}

async function createOrder(adapter: DynamoDBAdapter, id: string) {
  const createUow = adapter.createUnitOfWork(executorSchema, "shop");
  createUow.create("orders", { id, status: "open", total: 100 });
  await expect(createUow.executeMutations()).resolves.toEqual({ success: true });
}

async function findOrder(adapter: DynamoDBAdapter, id: string) {
  const findUow = adapter.createUnitOfWork(executorSchema, "shop");
  const withFind = findUow.find("orders", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", id)),
  );
  const [orders] = await withFind.executeRetrieve();
  return orders[0];
}

describeDynamoDBLocal("DynamoDB UOW executor", () => {
  it("creates a row and finds it through the primary sidecar index", async () => {
    const adapter = await createMigratedAdapter();

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
    const adapter = await createMigratedAdapter();

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
    const adapter = await createMigratedAdapter();

    const first = adapter.createUnitOfWork(executorSchema, "shop");
    first.create("orders", { id: "order_duplicate", status: "open", total: 1 });
    await expect(first.executeMutations()).resolves.toEqual({ success: true });

    const second = adapter.createUnitOfWork(executorSchema, "shop");
    second.create("orders", { id: "order_duplicate", status: "paid", total: 2 });
    await expect(second.executeMutations()).rejects.toThrow();
  });

  it("updates a row and increments its version", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_update");
    const order = await findOrder(adapter, "order_update");

    const updateUow = adapter.createUnitOfWork(executorSchema, "shop");
    updateUow.update("orders", order.id, (b) => b.set({ status: "paid", total: 125 }).check());
    await expect(updateUow.executeMutations()).resolves.toEqual({ success: true });

    const updated = await findOrder(adapter, "order_update");
    expect(updated).toMatchObject({ status: "paid", total: 125 });
    expect(updated.id.version).toBe(1);
  });

  it("deletes a row and removes the primary sidecar entry", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_delete");
    const order = await findOrder(adapter, "order_delete");

    const deleteUow = adapter.createUnitOfWork(executorSchema, "shop");
    deleteUow.delete("orders", order.id, (b) => b.check());
    await expect(deleteUow.executeMutations()).resolves.toEqual({ success: true });

    const deleted = await findOrder(adapter, "order_delete");
    expect(deleted).toBeUndefined();
  });

  it("checks current versions and returns false for stale checks", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_check");
    const order = await findOrder(adapter, "order_check");

    const checkUow = adapter.createUnitOfWork(executorSchema, "shop");
    checkUow.check("orders", order.id);
    await expect(checkUow.executeMutations()).resolves.toEqual({ success: true });

    const updateUow = adapter.createUnitOfWork(executorSchema, "shop");
    updateUow.update("orders", order.id, (b) => b.set({ status: "paid" }).check());
    await expect(updateUow.executeMutations()).resolves.toEqual({ success: true });

    const staleCheckUow = adapter.createUnitOfWork(executorSchema, "shop");
    staleCheckUow.check("orders", order.id);
    await expect(staleCheckUow.executeMutations()).resolves.toEqual({ success: false });
  });

  it("returns false for stale update and delete checks", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_stale_update");
    await createOrder(adapter, "order_stale_delete");
    const staleUpdateOrder = await findOrder(adapter, "order_stale_update");
    const staleDeleteOrder = await findOrder(adapter, "order_stale_delete");

    const updateFirst = adapter.createUnitOfWork(executorSchema, "shop");
    updateFirst.update("orders", staleUpdateOrder.id, (b) => b.set({ status: "paid" }).check());
    await expect(updateFirst.executeMutations()).resolves.toEqual({ success: true });

    const updateStale = adapter.createUnitOfWork(executorSchema, "shop");
    updateStale.update("orders", staleUpdateOrder.id, (b) => b.set({ status: "closed" }).check());
    await expect(updateStale.executeMutations()).resolves.toEqual({ success: false });

    const deleteFirst = adapter.createUnitOfWork(executorSchema, "shop");
    deleteFirst.update("orders", staleDeleteOrder.id, (b) => b.set({ status: "paid" }).check());
    await expect(deleteFirst.executeMutations()).resolves.toEqual({ success: true });

    const deleteStale = adapter.createUnitOfWork(executorSchema, "shop");
    deleteStale.delete("orders", staleDeleteOrder.id, (b) => b.check());
    await expect(deleteStale.executeMutations()).resolves.toEqual({ success: false });
  });

  it("coalesces check and update conditions on the same row", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_check_update");
    const order = await findOrder(adapter, "order_check_update");

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.check("orders", order.id);
    uow.update("orders", order.id, (b) => b.set({ status: "paid" }));
    await expect(uow.executeMutations()).resolves.toEqual({ success: true });

    const updated = await findOrder(adapter, "order_check_update");
    expect(updated.status).toBe("paid");
    expect(updated.id.version).toBe(1);
  });

  it("throws when two writes target the same base item", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_duplicate_write");

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.update("orders", "order_duplicate_write", (b) => b.set({ status: "paid" }));
    uow.delete("orders", "order_duplicate_write");

    await expect(uow.executeMutations()).rejects.toThrow(/multiple writes/);
  });
});
