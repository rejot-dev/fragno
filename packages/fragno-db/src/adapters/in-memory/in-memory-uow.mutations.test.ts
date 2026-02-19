import { describe, expect, it } from "vitest";
import type { AnySchema } from "../../schema/create";
import { column, idColumn, schema, FragnoId, referenceColumn } from "../../schema/create";
import { UnitOfWork, type UnitOfWorkConfig } from "../../query/unit-of-work/unit-of-work";
import { createInMemoryStore } from "./store";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import { resolveInMemoryAdapterOptions, type InMemoryAdapterOptions } from "./options";

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
        .addColumn("authorId", referenceColumn()),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    }),
);

const createTestUowFactory = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return () => new UnitOfWork(compiler, executor, decoder).forSchema(testSchema);
};

const createFkUowFactory = () => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return () => new UnitOfWork(compiler, executor, decoder).forSchema(fkSchema);
};

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

const createShardedUowFactory = <TSchema extends AnySchema>(testSchemaToUse: TSchema) => {
  const store = createInMemoryStore();
  const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });
  const compiler = createInMemoryUowCompiler();
  const executor = createInMemoryUowExecutor(store, options);
  const decoder = new InMemoryUowDecoder();

  return {
    createUow: (config?: UnitOfWorkConfig) =>
      new UnitOfWork(compiler, executor, decoder, undefined, config).forSchema(testSchemaToUse),
  };
};

describe("in-memory uow mutations", () => {
  it("updates rows with version checks and increments version", async () => {
    const createUow = createTestUowFactory();

    const createMutation = createUow();
    createMutation.create("users", { id: "user-1", name: "Jane" });
    const createResult = await createMutation.executeMutations();
    expect(createResult.success).toBe(true);

    const createdId = createMutation.getCreatedIds()[0]!;
    expect(createdId.version).toBe(0);

    const updateMutation = createUow();
    updateMutation.update("users", createdId, (b) => b.set({ name: "June" }).check());
    const updateResult = await updateMutation.executeMutations();
    expect(updateResult.success).toBe(true);

    const findAfterUpdate = createUow();
    findAfterUpdate.find("users", (b) => b.whereIndex("primary"));
    const rows = (await findAfterUpdate.executeRetrieve()) as unknown[];
    const updatedUser = (rows[0] as { id: FragnoId; name: string }[])[0];

    expect(updatedUser?.name).toBe("June");
    expect(updatedUser?.id).toBeInstanceOf(FragnoId);
    expect(updatedUser?.id.version).toBe(1);

    const staleUpdate = createUow();
    staleUpdate.update("users", createdId, (b) => b.set({ name: "Nope" }).check());
    const staleResult = await staleUpdate.executeMutations();
    expect(staleResult.success).toBe(false);

    const findAfterStale = createUow();
    findAfterStale.find("users", (b) => b.whereIndex("primary"));
    const staleRows = (await findAfterStale.executeRetrieve()) as unknown[];
    const staleUser = (staleRows[0] as { id: FragnoId; name: string }[])[0];

    expect(staleUser?.name).toBe("June");
    expect(staleUser?.id.version).toBe(1);
  });

  it("checks and deletes rows with version enforcement", async () => {
    const createUow = createTestUowFactory();

    const createMutation = createUow();
    createMutation.create("users", { id: "user-2", name: "Ari" });
    const createResult = await createMutation.executeMutations();
    expect(createResult.success).toBe(true);

    const createdId = createMutation.getCreatedIds()[0]!;

    const checkMutation = createUow();
    checkMutation.check("users", createdId);
    const checkResult = await checkMutation.executeMutations();
    expect(checkResult.success).toBe(true);

    const wrongVersionId = new FragnoId({
      externalId: createdId.externalId,
      internalId: createdId.internalId,
      version: createdId.version + 1,
    });

    const badCheck = createUow();
    badCheck.check("users", wrongVersionId);
    const badCheckResult = await badCheck.executeMutations();
    expect(badCheckResult.success).toBe(false);

    const badDelete = createUow();
    badDelete.delete("users", wrongVersionId, (b) => b.check());
    const badDeleteResult = await badDelete.executeMutations();
    expect(badDeleteResult.success).toBe(false);

    const findBeforeDelete = createUow();
    findBeforeDelete.find("users", (b) => b.whereIndex("primary"));
    const beforeDeleteRows = (await findBeforeDelete.executeRetrieve()) as unknown[];
    expect(beforeDeleteRows[0]).toHaveLength(1);

    const deleteMutation = createUow();
    deleteMutation.delete("users", createdId, (b) => b.check());
    const deleteResult = await deleteMutation.executeMutations();
    expect(deleteResult.success).toBe(true);

    const findAfterDelete = createUow();
    findAfterDelete.find("users", (b) => b.whereIndex("primary"));
    const afterDeleteRows = (await findAfterDelete.executeRetrieve()) as unknown[];
    expect(afterDeleteRows[0]).toHaveLength(0);
  });

  it("enforces foreign keys on create and update", async () => {
    const createUow = createFkUowFactory();

    const createUser = createUow();
    createUser.create("users", { id: "user-1", name: "Ada" });
    const createUserResult = await createUser.executeMutations();
    expect(createUserResult.success).toBe(true);

    const userId = createUser.getCreatedIds()[0]!;

    const createPost = createUow();
    createPost.create("posts", {
      id: "post-1",
      title: "Hello",
      authorId: userId,
    });
    const createPostResult = await createPost.executeMutations();
    expect(createPostResult.success).toBe(true);

    const badCreate = createUow();
    badCreate.create("posts", {
      id: "post-2",
      title: "Nope",
      authorId: "missing-user",
    });
    await expect(badCreate.executeMutations()).rejects.toThrow("Foreign key constraint violation");

    const postId = createPost.getCreatedIds()[0]!;
    const badUpdate = createUow();
    badUpdate.update("posts", postId, (b) => b.set({ authorId: "missing-user" }));
    await expect(badUpdate.executeMutations()).rejects.toThrow("Foreign key constraint violation");
  });

  it("enforces foreign keys on delete", async () => {
    const createUow = createFkUowFactory();

    const createUser = createUow();
    createUser.create("users", { id: "user-2", name: "Sam" });
    const createUserResult = await createUser.executeMutations();
    expect(createUserResult.success).toBe(true);

    const userId = createUser.getCreatedIds()[0]!;

    const createPost = createUow();
    createPost.create("posts", {
      id: "post-3",
      title: "Dependent",
      authorId: userId,
    });
    const createPostResult = await createPost.executeMutations();
    expect(createPostResult.success).toBe(true);

    const deleteUser = createUow();
    deleteUser.delete("users", userId, (b) => b.check());
    await expect(deleteUser.executeMutations()).rejects.toThrow("Foreign key constraint violation");
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
    expect(firstResult.success).toBe(true);

    const secondCreate = createUow();
    secondCreate.create("users", { id: "user-2", name: "Bea" });
    const secondResult = await secondCreate.executeMutations();
    expect(secondResult.success).toBe(true);

    const [firstId, secondId] = [firstCreate.getCreatedIds()[0]!, secondCreate.getCreatedIds()[0]!];

    expect(firstId.internalId).toBe(10n);
    expect(secondId.internalId).toBe(11n);
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
    expect(firstResult.success).toBe(true);

    const createUserDup = createUow();
    createUserDup.create("users", { id: "dup-id", name: "Second" });
    const secondResult = await createUserDup.executeMutations();
    expect(secondResult.success).toBe(true);

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
    expect(createPostResult.success).toBe(true);

    const createdPostId = createPost.getCreatedIds()[0]!;
    const updatePost = createFkUow();
    updatePost.update("posts", createdPostId, (b) => b.set({ authorId: "still-missing" }));
    const updatePostResult = await updatePost.executeMutations();
    expect(updatePostResult.success).toBe(true);

    const createUserForDelete = createFkUow();
    createUserForDelete.create("users", { id: "user-3", name: "Sam" });
    const createUserForDeleteResult = await createUserForDelete.executeMutations();
    expect(createUserForDeleteResult.success).toBe(true);

    const userId = createUserForDelete.getCreatedIds()[0]!;
    const createPostForDelete = createFkUow();
    createPostForDelete.create("posts", {
      id: "post-2",
      title: "Dependent",
      authorId: userId,
    });
    const createPostForDeleteResult = await createPostForDelete.executeMutations();
    expect(createPostForDeleteResult.success).toBe(true);

    const deleteUser = createFkUow();
    deleteUser.delete("users", userId, (b) => b.check());
    const deleteResult = await deleteUser.executeMutations();
    expect(deleteResult.success).toBe(true);
  });

  it("enforces shard filters for update, delete, and check in row mode", async () => {
    const { createUow } = createShardedUowFactory(testSchema);
    const shardingStrategy = { mode: "row" } as const;

    const createShardA = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    createShardA.create("users", { id: "user-1", name: "Ada" });
    const createResult = await createShardA.executeMutations();
    expect(createResult.success).toBe(true);

    const createdId = createShardA.getCreatedIds()[0]!;

    const checkWrongShard = createUow({
      shardingStrategy,
      getShard: () => "shard-b",
    });
    checkWrongShard.check("users", createdId);
    const checkResult = await checkWrongShard.executeMutations();
    expect(checkResult.success).toBe(false);

    const updateWrongShard = createUow({
      shardingStrategy,
      getShard: () => "shard-b",
    });
    updateWrongShard.update("users", createdId, (b) => b.set({ name: "Nope" }).check());
    const updateResult = await updateWrongShard.executeMutations();
    expect(updateResult.success).toBe(false);

    const deleteWrongShard = createUow({
      shardingStrategy,
      getShard: () => "shard-b",
    });
    deleteWrongShard.delete("users", createdId, (b) => b.check());
    const deleteResult = await deleteWrongShard.executeMutations();
    expect(deleteResult.success).toBe(false);

    const updateRightShard = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    updateRightShard.update("users", createdId, (b) => b.set({ name: "Ada Lovelace" }).check());
    const updateRightResult = await updateRightShard.executeMutations();
    expect(updateRightResult.success).toBe(true);

    const findAfterUpdate = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    findAfterUpdate.find("users", (b) => b.whereIndex("primary"));
    const rows = (await findAfterUpdate.executeRetrieve()) as unknown[];
    const updatedUser = (rows[0] as { name: string }[])[0];
    expect(updatedUser?.name).toBe("Ada Lovelace");
  });

  it("allows global shard scope to bypass row filters", async () => {
    const { createUow } = createShardedUowFactory(testSchema);
    const shardingStrategy = { mode: "row" } as const;

    const createShardA = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
    });
    createShardA.create("users", { id: "user-1", name: "Ada" });
    await createShardA.executeMutations();

    const updateGlobal = createUow({
      shardingStrategy,
      getShard: () => "shard-b",
      getShardScope: () => "global",
    });
    updateGlobal.update("users", "user-1", (b) => b.set({ name: "Global" }));
    const updateResult = await updateGlobal.executeMutations();
    expect(updateResult.success).toBe(true);

    const findGlobal = createUow({
      shardingStrategy,
      getShard: () => "shard-a",
      getShardScope: () => "global",
    });
    findGlobal.find("users", (b) => b.whereIndex("primary"));
    const rows = (await findGlobal.executeRetrieve()) as unknown[];
    const updatedUser = (rows[0] as { name: string }[])[0];
    expect(updatedUser?.name).toBe("Global");
  });
});
