import { describe, expect, it, assert, vi } from "vitest";

import { UnitOfWork } from "../../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../../schema/create";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import { resolveInMemoryAdapterOptions, type InMemoryAdapterOptions } from "./options";
import { createInMemoryStore } from "./store";

const testSchema = schema("test", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const fkSchema = schema("fk", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("authorId", referenceColumn({ table: "users" })),
    ),
);

const mutableValuesSchema = schema("mutable-values", (s) =>
  s.addTable("records", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("payload", column("json"))
      .addColumn("occurredAt", column("timestamp"))
      .addColumn("bytes", column("binary")),
  ),
);

const uniqueKeySchema = schema("unique-key", (s) =>
  s.addTable("records", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("scope", column("string"))
      .addColumn("key", column("string"))
      .createIndex("records_scope_key_idx", ["scope", "key"], { unique: true }),
  ),
);

const createUowFactoryWithOptions = <TSchema extends AnySchema>(
  testSchemaToUse: TSchema,
  optionsOverrides: InMemoryAdapterOptions = {},
) => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed", ...optionsOverrides });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: () => new UnitOfWork(compiler, executor, decoder).forSchema(testSchemaToUse),
    options,
    store,
  };
};

describe("in-memory uow mutations", () => {
  it("uses a bounded exact-key scan for absence checks", async () => {
    const { createUow, store } = createUowFactoryWithOptions(uniqueKeySchema);
    const seed = createUow();
    seed.create("records", { id: "record-1", scope: "scope-a", key: "key-a" });
    seed.create("records", { id: "record-2", scope: "scope-b", key: "key-b" });
    assert((await seed.executeMutations()).success);

    const indexStore = store.namespaces
      .get("unique-key")
      ?.tables.get("records")
      ?.indexes.get("records_scope_key_idx");
    assert(indexStore);
    const scan = vi.spyOn(indexStore.index, "scan");

    const check = createUow();
    check.checkAbsent("records", "records_scope_key_idx", {
      scope: "scope-b",
      key: "missing-key",
    });
    assert((await check.executeMutations()).success);

    expect(scan).toHaveBeenCalledExactlyOnceWith({
      start: ["scope-b", "missing-key"],
      startInclusive: true,
      end: ["scope-b", "missing-key"],
      endInclusive: true,
      limit: 1,
    });
  });

  it("snapshots mutable column values on writes and reads", async () => {
    const { createUow } = createUowFactoryWithOptions(mutableValuesSchema);
    const payload = { nested: { value: "created" } };
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3]);

    const create = createUow();
    create.create("records", {
      id: "record-1",
      payload,
      occurredAt,
      bytes,
    });
    const createResult = await create.executeMutations();
    assert(createResult.success);
    const recordId = create.getCreatedIds()[0]!;

    payload.nested.value = "mutated after create";
    occurredAt.setUTCFullYear(2030);
    bytes[0] = 9;

    const readRecord = async () => {
      const retrieve = createUow();
      retrieve.findFirst("records", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", "record-1")),
      );
      const [record] = (await retrieve.executeRetrieve()) as unknown as [
        {
          payload: { nested: { value: string } };
          occurredAt: Date;
          bytes: Uint8Array;
        } | null,
      ];
      assert(record);
      return record;
    };

    const created = await readRecord();
    expect(created.payload).toEqual({ nested: { value: "created" } });
    expect(created.occurredAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(created.bytes).toEqual(new Uint8Array([1, 2, 3]));

    created.payload.nested.value = "mutated after read";
    created.occurredAt.setUTCFullYear(2040);
    created.bytes[1] = 8;
    const reread = await readRecord();
    expect(reread.payload).toEqual({ nested: { value: "created" } });
    expect(reread.occurredAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(reread.bytes).toEqual(new Uint8Array([1, 2, 3]));

    const updatePayload = { nested: { value: "updated" } };
    const updateOccurredAt = new Date("2026-02-01T00:00:00.000Z");
    const updateBytes = new Uint8Array([4, 5, 6]);
    const update = createUow();
    update.update("records", recordId, (b) =>
      b.set({
        payload: updatePayload,
        occurredAt: updateOccurredAt,
        bytes: updateBytes,
      }),
    );
    const updateResult = await update.executeMutations();
    assert(updateResult.success);

    updatePayload.nested.value = "mutated after update";
    updateOccurredAt.setUTCFullYear(2050);
    updateBytes[2] = 7;
    const updated = await readRecord();
    expect(updated.payload).toEqual({ nested: { value: "updated" } });
    expect(updated.occurredAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(updated.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("uses custom internal id generators when provided", async () => {
    let current = 9n;
    const internalIdGenerator = () => {
      current += 1n;
      return current;
    };
    const { createUow } = createUowFactoryWithOptions(testSchema, { internalIdGenerator });

    const firstCreate = createUow();
    firstCreate.create("users", { id: "user-1", name: "Ari" });
    const firstResult = await firstCreate.executeMutations();
    assert(firstResult.success);

    const secondCreate = createUow();
    secondCreate.create("users", { id: "user-2", name: "Bea" });
    const secondResult = await secondCreate.executeMutations();
    assert(secondResult.success);

    const [firstId, secondId] = [firstCreate.getCreatedIds()[0]!, secondCreate.getCreatedIds()[0]!];

    assert(firstId.internalId === 10n);
    assert(secondId.internalId === 11n);
  });

  it("skips foreign key and unique constraints when enforceConstraints is false", async () => {
    const { createUow } = createUowFactoryWithOptions(testSchema, {
      enforceConstraints: false,
    });
    const { createUow: createFkUow } = createUowFactoryWithOptions(fkSchema, {
      enforceConstraints: false,
    });

    const createUser = createUow();
    createUser.create("users", { id: "dup-id", name: "First" });
    const firstResult = await createUser.executeMutations();
    assert(firstResult.success);

    const createUserDup = createUow();
    createUserDup.create("users", { id: "dup-id", name: "Second" });
    const secondResult = await createUserDup.executeMutations();
    assert(secondResult.success);

    const findDupes = createUow();
    findDupes.find("users", (b) => b.whereIndex("primary"));
    const dupeRows = (await findDupes.executeRetrieve()) as unknown[];
    expect(dupeRows[0]).toHaveLength(2);

    const createPost = createFkUow();
    createPost.create("posts", {
      id: "post-1",
      title: "No author",
      authorId: "missing-user",
    });
    const createPostResult = await createPost.executeMutations();
    assert(createPostResult.success);

    const createdPostId = createPost.getCreatedIds()[0]!;
    const updatePost = createFkUow();
    updatePost.update("posts", createdPostId, (b) => b.set({ authorId: "still-missing" }));
    const updatePostResult = await updatePost.executeMutations();
    assert(updatePostResult.success);

    const createUserForDelete = createFkUow();
    createUserForDelete.create("users", { id: "user-3", name: "Sam" });
    const createUserForDeleteResult = await createUserForDelete.executeMutations();
    assert(createUserForDeleteResult.success);

    const userId = createUserForDelete.getCreatedIds()[0]!;
    const createPostForDelete = createFkUow();
    createPostForDelete.create("posts", {
      id: "post-2",
      title: "Dependent",
      authorId: userId,
    });
    const createPostForDeleteResult = await createPostForDelete.executeMutations();
    assert(createPostForDeleteResult.success);

    const deleteUser = createFkUow();
    deleteUser.delete("users", userId, (b) => b.check());
    const deleteResult = await deleteUser.executeMutations();
    assert(deleteResult.success);
  });
});
