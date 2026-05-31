import { expect, it } from "vitest";

import superjson from "superjson";

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { getOutboxStateForAdapter } from "../../internal/outbox-state";
import type { OutboxPayload } from "../../outbox/outbox";
import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
} from "../../schema/create";
import { DynamoDBAdapter } from "./dynamodb-adapter";
import { createDynamoDBLayout } from "./dynamodb-layout";
import { describeDynamoDBLocal, getDynamoDBLocalTestContext } from "./test-utils";

const executorSchema = schema("shop", (s) =>
  s.addTable("orders", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("status", column("string"))
      .addColumn("total", column("integer"))
      .addColumn("receipt", column("string").nullable())
      .createIndex("by_status", ["status", "total"])
      .createIndex("receipt_unique", ["receipt"], { unique: true }),
  ),
);

const queryTreeSchema = schema("blog", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .createIndex("posts_user_idx", ["user_id"]),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn({ table: "posts" }))
        .addColumn("body", column("string"))
        .createIndex("comments_post_idx", ["post_id"]),
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

async function createMigratedQueryTreeAdapter() {
  const context = getDynamoDBLocalTestContext();
  expect(context).not.toBeNull();
  const adapter = new DynamoDBAdapter({
    client: context!.client,
    tablePrefix: context!.tablePrefix,
  });
  await adapter.prepareMigrations(queryTreeSchema, "blog").execute(0);
  return adapter;
}

async function createMigratedOutboxAdapter(options: { enabled?: boolean } = {}) {
  const context = getDynamoDBLocalTestContext();
  expect(context).not.toBeNull();
  const adapter = new DynamoDBAdapter({
    client: context!.client,
    tablePrefix: context!.tablePrefix,
  });
  await adapter.prepareMigrations(executorSchema, "shop").execute(0);
  await adapter.prepareMigrations(internalSchema, null).execute(0);

  if (options.enabled) {
    enableOutboxForNamespace(adapter, "shop");
  }

  return { adapter, context: context! };
}

function enableOutboxForNamespace(adapter: DynamoDBAdapter, namespace: string) {
  const outboxState = getOutboxStateForAdapter(adapter as never);
  outboxState.config.enabled = true;
  outboxState.enabledSchemaKeys.add(namespace);
}

async function listOutboxEntries(adapter: DynamoDBAdapter) {
  const uow = adapter.createUnitOfWork(internalSchema, null, undefined, { allowScans: true });
  const withEntries = uow.find("fragno_db_outbox", (b) =>
    b.whereIndex("idx_outbox_versionstamp").orderByIndex("idx_outbox_versionstamp", "asc"),
  );
  const [entries] = await withEntries.executeRetrieve();
  return entries;
}

function decodeOutboxPayload(entry: { payload: unknown }) {
  return superjson.deserialize<OutboxPayload>(entry.payload as never);
}

async function createOrder(adapter: DynamoDBAdapter, id: string) {
  const createUow = adapter.createUnitOfWork(executorSchema, "shop");
  createUow.create("orders", { id, status: "open", total: 100, receipt: null });
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

  it("finds rows by secondary index in index order", async () => {
    const adapter = await createMigratedAdapter();
    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_idx_3", status: "queued", total: 30 });
    createUow.create("orders", { id: "order_idx_1", status: "queued", total: 10 });
    createUow.create("orders", { id: "order_idx_paid", status: "paid", total: 20 });
    createUow.create("orders", { id: "order_idx_2", status: "queued", total: 20 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const findUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withFind = findUow.find("orders", (b) =>
      b
        .whereIndex("by_status", (eb) => eb("status", "=", "queued"))
        .orderByIndex("by_status", "asc"),
    );
    const [orders] = await withFind.executeRetrieve();

    expect(orders.map((order: { id: FragnoId }) => order.id.externalId)).toEqual([
      "order_idx_1",
      "order_idx_2",
      "order_idx_3",
    ]);
  });

  it("updates and deletes secondary index entries", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_reindex");
    const order = await findOrder(adapter, "order_reindex");

    const updateUow = adapter.createUnitOfWork(executorSchema, "shop");
    updateUow.update("orders", order.id, (b) => b.set({ status: "paid", total: 500 }).check());
    await expect(updateUow.executeMutations()).resolves.toEqual({ success: true });

    const oldIndexUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withOldFind = oldIndexUow.find("orders", (b) =>
      b.whereIndex("by_status", (eb) => eb("status", "=", "open")),
    );
    const [oldRows] = await withOldFind.executeRetrieve();
    expect(oldRows).toHaveLength(0);

    const newIndexUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withNewFind = newIndexUow.find("orders", (b) =>
      b.whereIndex("by_status", (eb) => eb("status", "=", "paid")),
    );
    const [newRows] = await withNewFind.executeRetrieve();
    expect(newRows.map((row: { id: FragnoId }) => row.id.externalId)).toEqual(["order_reindex"]);

    const deleteUow = adapter.createUnitOfWork(executorSchema, "shop");
    deleteUow.delete("orders", "order_reindex");
    await expect(deleteUow.executeMutations()).resolves.toEqual({ success: true });

    const deletedIndexUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withDeletedFind = deletedIndexUow.find("orders", (b) =>
      b.whereIndex("by_status", (eb) => eb("status", "=", "paid")),
    );
    const [deletedRows] = await withDeletedFind.executeRetrieve();
    expect(deletedRows).toHaveLength(0);
  });

  it("enforces unique secondary indexes", async () => {
    const adapter = await createMigratedAdapter();
    const first = adapter.createUnitOfWork(executorSchema, "shop");
    first.create("orders", {
      id: "order_receipt_1",
      status: "paid",
      total: 1,
      receipt: "receipt_1",
    });
    await expect(first.executeMutations()).resolves.toEqual({ success: true });

    const second = adapter.createUnitOfWork(executorSchema, "shop");
    second.create("orders", {
      id: "order_receipt_2",
      status: "paid",
      total: 2,
      receipt: "receipt_1",
    });
    await expect(second.executeMutations()).rejects.toThrow();
  });

  it("paginates secondary index results with a cursor", async () => {
    const adapter = await createMigratedAdapter();
    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_page_1", status: "page", total: 1 });
    createUow.create("orders", { id: "order_page_2", status: "page", total: 2 });
    createUow.create("orders", { id: "order_page_3", status: "page", total: 3 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const firstPageUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withFirstPage = firstPageUow.findWithCursor("orders", (b) =>
      b
        .whereIndex("by_status", (eb) => eb("status", "=", "page"))
        .orderByIndex("by_status", "asc")
        .pageSize(2),
    );
    const [firstPage] = await withFirstPage.executeRetrieve();

    expect(firstPage.items.map((order: { id: FragnoId }) => order.id.externalId)).toEqual([
      "order_page_1",
      "order_page_2",
    ]);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeDefined();

    const secondPageUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withSecondPage = secondPageUow.findWithCursor("orders", (b) =>
      b.after(firstPage.cursor!),
    );
    const [secondPage] = await withSecondPage.executeRetrieve();

    expect(secondPage.items.map((order: { id: FragnoId }) => order.id.externalId)).toEqual([
      "order_page_3",
    ]);
    expect(secondPage.hasNextPage).toBe(false);
  });

  it("counts rows by secondary index", async () => {
    const adapter = await createMigratedAdapter();
    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_count_1", status: "counted", total: 1 });
    createUow.create("orders", { id: "order_count_2", status: "counted", total: 2 });
    createUow.create("orders", { id: "order_count_other", status: "ignored", total: 3 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const countUow = adapter.createUnitOfWork(executorSchema, "shop");
    const withCount = countUow.find("orders", (b) =>
      b.whereIndex("by_status", (eb) => eb("status", "=", "counted")).selectCount(),
    );
    const [count] = await withCount.executeRetrieve();

    expect(count).toBe(2);
  });

  it("throws when two writes target the same base item", async () => {
    const adapter = await createMigratedAdapter();
    await createOrder(adapter, "order_duplicate_write");

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.update("orders", "order_duplicate_write", (b) => b.set({ status: "paid" }));
    uow.delete("orders", "order_duplicate_write");

    await expect(uow.executeMutations()).rejects.toThrow(/multiple writes/);
  });

  it("creates rows with reference columns and reads one-level query-tree joins", async () => {
    const adapter = await createMigratedQueryTreeAdapter();

    const createUow = adapter.createUnitOfWork(queryTreeSchema, "blog");
    createUow.create("users", { id: "user_qt_1", name: "Ada" });
    createUow.create("posts", { id: "post_qt_2", user_id: "user_qt_1", title: "Second" });
    createUow.create("posts", { id: "post_qt_1", user_id: "user_qt_1", title: "First" });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const readUow = adapter.createUnitOfWork(queryTreeSchema, "blog");
    const withUsers = readUow.find("users", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", "user_qt_1"))
        .joinMany("posts", "posts", (post) =>
          post
            .onIndex("posts_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
            .select(["id", "user_id", "title"]),
        ),
    );
    const [users] = await withUsers.executeRetrieve();

    expect(users).toHaveLength(1);
    expect(users[0].posts.map((post: { id: FragnoId }) => post.id.externalId)).toEqual([
      "post_qt_1",
      "post_qt_2",
    ]);
    expect(users[0].posts[0].user_id).toBeInstanceOf(FragnoReference);
  });

  it("decodes nested query-tree joins", async () => {
    const adapter = await createMigratedQueryTreeAdapter();

    const createUow = adapter.createUnitOfWork(queryTreeSchema, "blog");
    createUow.create("users", { id: "user_nested", name: "Grace" });
    createUow.create("posts", { id: "post_nested", user_id: "user_nested", title: "Compiler" });
    createUow.create("comments", { id: "comment_nested", post_id: "post_nested", body: "Nice" });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const readUow = adapter.createUnitOfWork(queryTreeSchema, "blog");
    const withUsers = readUow.find("users", (b) =>
      b
        .whereIndex("primary", (eb) => eb("id", "=", "user_nested"))
        .joinMany("posts", "posts", (post) =>
          post
            .onIndex("posts_user_idx", (eb) => eb("user_id", "=", eb.parent("id")))
            .joinMany("comments", "comments", (comment) =>
              comment.onIndex("comments_post_idx", (eb) => eb("post_id", "=", eb.parent("id"))),
            ),
        ),
    );
    const [users] = await withUsers.executeRetrieve();

    expect(users[0].posts[0].comments).toHaveLength(1);
    expect(users[0].posts[0].comments[0]).toMatchObject({ body: "Nice" });
  });

  it("throws when a reference external ID is missing", async () => {
    const adapter = await createMigratedQueryTreeAdapter();

    const uow = adapter.createUnitOfWork(queryTreeSchema, "blog");
    uow.create("posts", { id: "post_missing_ref", user_id: "missing_user", title: "Oops" });

    await expect(uow.executeMutations()).rejects.toThrow(/Foreign key constraint violation/);
  });

  it("does not write outbox entries when disabled", async () => {
    const { adapter } = await createMigratedOutboxAdapter({ enabled: false });

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.create("orders", { id: "order_outbox_disabled", status: "open", total: 1 });
    await expect(uow.executeMutations()).resolves.toEqual({ success: true });

    await expect(listOutboxEntries(adapter)).resolves.toHaveLength(0);
  });

  it("writes outbox entries for create, update, and delete UOWs", async () => {
    const { adapter } = await createMigratedOutboxAdapter({ enabled: true });

    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_outbox", status: "open", total: 1 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });

    const order = await findOrder(adapter, "order_outbox");
    const updateUow = adapter.createUnitOfWork(executorSchema, "shop");
    updateUow.update("orders", order.id, (b) => b.set({ status: "paid" }).check());
    await expect(updateUow.executeMutations()).resolves.toEqual({ success: true });

    const updated = await findOrder(adapter, "order_outbox");
    const deleteUow = adapter.createUnitOfWork(executorSchema, "shop");
    deleteUow.delete("orders", updated.id, (b) => b.check());
    await expect(deleteUow.executeMutations()).resolves.toEqual({ success: true });

    const entries = await listOutboxEntries(adapter);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry: { versionstamp: string }) => entry.versionstamp)).toEqual([
      "000000000000000000000000",
      "000000000000000000010000",
      "000000000000000000020000",
    ]);
    expect(entries.map((entry) => decodeOutboxPayload(entry).mutations[0]?.op)).toEqual([
      "create",
      "update",
      "delete",
    ]);
  });

  it("writes outbox mutation rows in payload order", async () => {
    const { adapter } = await createMigratedOutboxAdapter({ enabled: true });

    const uow = adapter.createUnitOfWork(executorSchema, "shop");
    uow.create("orders", { id: "order_outbox_a", status: "open", total: 1 });
    uow.create("orders", { id: "order_outbox_b", status: "paid", total: 2 });
    await expect(uow.executeMutations()).resolves.toEqual({ success: true });

    const entries = await listOutboxEntries(adapter);
    const payload = decodeOutboxPayload(entries[0]);
    expect(payload.mutations.map((mutation) => mutation.externalId)).toEqual([
      "order_outbox_a",
      "order_outbox_b",
    ]);

    const mutationUow = adapter.createUnitOfWork(internalSchema, null);
    const withMutations = mutationUow.find("fragno_db_outbox_mutations", (b) =>
      b
        .whereIndex("idx_outbox_mutations_entry", (eb) =>
          eb("entryVersionstamp", "=", entries[0].versionstamp),
        )
        .orderByIndex("idx_outbox_mutations_entry", "asc"),
    );
    const [mutationRows] = await withMutations.executeRetrieve();
    expect(mutationRows.map((row: { externalId: string }) => row.externalId)).toEqual([
      "order_outbox_a",
      "order_outbox_b",
    ]);
  });

  it("does not write outbox rows for failed stale mutations", async () => {
    const { adapter } = await createMigratedOutboxAdapter({ enabled: true });

    const createUow = adapter.createUnitOfWork(executorSchema, "shop");
    createUow.create("orders", { id: "order_outbox_stale", status: "open", total: 1 });
    await expect(createUow.executeMutations()).resolves.toEqual({ success: true });
    const staleOrder = await findOrder(adapter, "order_outbox_stale");

    const updateFirst = adapter.createUnitOfWork(executorSchema, "shop");
    updateFirst.update("orders", staleOrder.id, (b) => b.set({ status: "paid" }).check());
    await expect(updateFirst.executeMutations()).resolves.toEqual({ success: true });

    const updateStale = adapter.createUnitOfWork(executorSchema, "shop");
    updateStale.update("orders", staleOrder.id, (b) => b.set({ status: "closed" }).check());
    await expect(updateStale.executeMutations()).resolves.toEqual({ success: false });

    await expect(listOutboxEntries(adapter)).resolves.toHaveLength(2);
  });

  it("resolves outbox reference maps from stored internal IDs", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const adapter = new DynamoDBAdapter({
      client: context!.client,
      tablePrefix: context!.tablePrefix,
    });
    await adapter.prepareMigrations(queryTreeSchema, "blog").execute(0);
    await adapter.prepareMigrations(internalSchema, null).execute(0);
    enableOutboxForNamespace(adapter, "blog");

    const createUser = adapter.createUnitOfWork(queryTreeSchema, "blog");
    createUser.create("users", { id: "user_outbox_ref", name: "Ref" });
    await expect(createUser.executeMutations()).resolves.toEqual({ success: true });

    const readUser = adapter.createUnitOfWork(queryTreeSchema, "blog");
    const withUser = readUser.find("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", "user_outbox_ref")),
    );
    const [users] = await withUser.executeRetrieve();

    expect(users[0].id.internalId).toBeDefined();
    const createPost = adapter.createUnitOfWork(queryTreeSchema, "blog");
    createPost.create("posts", {
      id: "post_outbox_ref",
      user_id: FragnoReference.fromInternal(users[0].id.internalId!),
      title: "Ref post",
    });
    await expect(createPost.executeMutations()).resolves.toEqual({ success: true });

    const entries = await listOutboxEntries(adapter);
    expect(entries[1].refMap).toEqual({ "0.user_id": "user_outbox_ref" });
  });

  it("returns false when the outbox version row is contended", async () => {
    const { context } = await createMigratedOutboxAdapter({ enabled: false });
    const settingsTableName = createDynamoDBLayout({
      schema: internalSchema,
      namespace: null,
      tablePrefix: context.tablePrefix,
    }).settingsTableName;
    let contendNextTransaction = true;
    const contendingAdapter = new DynamoDBAdapter({
      tablePrefix: context.tablePrefix,
      client: {
        send: async (command: object) => {
          if (command.constructor.name === "TransactWriteCommand" && contendNextTransaction) {
            contendNextTransaction = false;
            await context.client.send(
              new UpdateCommand({
                TableName: settingsTableName,
                Key: { pk: "outbox_version", sk: "global" },
                UpdateExpression: "SET #value = :value",
                ExpressionAttributeNames: { "#value": "value" },
                ExpressionAttributeValues: { ":value": "99" },
              }),
            );
          }
          return context.client.send(command as never);
        },
      } as never,
    });
    const outboxState = getOutboxStateForAdapter(contendingAdapter as never);
    outboxState.config.enabled = true;
    outboxState.enabledSchemaKeys.add("shop");

    const uow = contendingAdapter.createUnitOfWork(executorSchema, "shop");
    uow.create("orders", { id: "order_outbox_contended", status: "open", total: 1 });
    await expect(uow.executeMutations()).resolves.toEqual({ success: false });
    await expect(listOutboxEntries(contendingAdapter)).resolves.toHaveLength(0);
  });
});
