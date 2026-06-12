import { describe, expect, it, assert } from "vitest";

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
