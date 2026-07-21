import { describe, expect, it, assert } from "vitest";

import {
  column,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
  type FragnoId,
} from "@fragno-dev/db/schema";

import type { DatabaseRequestContext } from "@fragno-dev/db";

import { fragnoCollectionOptions } from "./collection-options";
import {
  createIngestScenarioSteps,
  defineIngestScenario,
  runIngestScenario,
  type IngestScenarioCollectionOptionsFactory,
  type IngestScenarioContext,
  type IngestScenarioStep,
} from "./scenario";

const referenceSchema = schema("references", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .createIndex("idx_users_email", ["email"], { unique: true }),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string")),
    ),
);

const valueSchema = schema("values", (s) =>
  s
    .addTable("records", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("occurredAt", column("timestamp"))
        .addColumn("birthday", column("date"))
        .addColumn("payload", column("json"))
        .addColumn("counter", column("bigint"))
        .addColumn("enabled", column("bool"))
        .addColumn("nickname", column("string").nullable())
        .addColumn("bytes", column("binary")),
    )
    .addTable("defaults", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("label", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((builder) => builder.now()),
        )
        .addColumn("count", column("integer").defaultTo(0))
        .addColumn("enabled", column("bool").defaultTo(true)),
    ),
);

function createCollectionOptions<
  TSchema extends typeof referenceSchema | typeof valueSchema,
  TTableName extends keyof TSchema["tables"] & string,
>(): IngestScenarioCollectionOptionsFactory<TSchema, TTableName> {
  return ({ id, coordinator, target }) =>
    fragnoCollectionOptions({
      id,
      coordinator,
      target,
    });
}

async function runScenario<
  TSchema extends typeof referenceSchema | typeof valueSchema,
  TTableName extends keyof TSchema["tables"] & string,
>(options: {
  name: string;
  schema: TSchema;
  table: TTableName;
  steps: IngestScenarioStep<TSchema, TTableName>[];
  collectionOptions: IngestScenarioCollectionOptionsFactory<TSchema, TTableName>;
}): Promise<void> {
  const context = await runIngestScenario(
    defineIngestScenario({
      name: options.name,
      schema: options.schema,
      table: options.table,
      collectionOptions: options.collectionOptions,
      steps: options.steps,
    }),
  );
  await context.cleanup();
}

const userSteps = createIngestScenarioSteps<typeof referenceSchema, "users">();
const postSteps = createIngestScenarioSteps<typeof referenceSchema, "posts">();
const recordSteps = createIngestScenarioSteps<typeof valueSchema, "records">();
const defaultSteps = createIngestScenarioSteps<typeof valueSchema, "defaults">();

const createUserCollectionOptions = createCollectionOptions<typeof referenceSchema, "users">();
const createPostCollectionOptions = createCollectionOptions<typeof referenceSchema, "posts">();
const createRecordCollectionOptions = createCollectionOptions<typeof valueSchema, "records">();
const createDefaultCollectionOptions = createCollectionOptions<typeof valueSchema, "defaults">();

type ReferenceServer = IngestScenarioContext<typeof referenceSchema, "users">["server"];

async function createGeneratedUser(server: ReferenceServer, email: string): Promise<FragnoId> {
  return await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(referenceSchema).create("users", { email }))
      .execute();

    const user = await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(referenceSchema).findFirst("users", (query) =>
          query.whereIndex("idx_users_email", (expression) => expression("email", "=", email)),
        ),
      )
      .transformRetrieve(([result]) => result)
      .execute();

    if (!user) {
      throw new Error(`Expected generated user ${email} to exist.`);
    }

    return user.id;
  });
}

async function createPostWithInternalReference(
  server: ReferenceServer,
  post: { id: string; title: string },
  authorId: FragnoId,
): Promise<void> {
  assert(authorId.internalId !== undefined);

  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) =>
        forSchema(referenceSchema).create("posts", {
          ...post,
          authorId: FragnoReference.fromInternal(authorId.internalId!),
        }),
      )
      .execute();
  });
}

describe("Fragno outbox identity and reference materialization", () => {
  it("materializes a server-generated external ID as the collection key", async () => {
    let generatedId: FragnoId | undefined;

    await runScenario({
      name: "generated-external-id",
      schema: referenceSchema,
      table: "users",
      collectionOptions: createUserCollectionOptions,
      steps: [
        userSteps.server(async ({ server }) => {
          generatedId = await createGeneratedUser(server, "generated@example.com");
        }),
        userSteps.ingest(),
        userSteps.assert(async ({ frontend }) => {
          assert(generatedId);
          expect(frontend.collection.get(generatedId.externalId)).toMatchObject({
            id: generatedId.externalId,
            email: "generated@example.com",
          });
          await expect(frontend.readPersistedRows()).resolves.toContainEqual(
            expect.objectContaining({ key: generatedId.externalId }),
          );
        }),
        userSteps.reload(),
        userSteps.assert(({ frontend }) => {
          assert(generatedId);
          assert(
            frontend.collection.get(generatedId.externalId)?.email === "generated@example.com",
          );
        }),
      ],
    });
  });

  it("resolves an internal reference through the outbox refMap", async () => {
    let authorId: FragnoId | undefined;
    const post = { id: "post-1", title: "Analytical Engine" };

    await runScenario({
      name: "internal-reference",
      schema: referenceSchema,
      table: "posts",
      collectionOptions: createPostCollectionOptions,
      steps: [
        postSteps.server(async ({ server }) => {
          authorId = await createGeneratedUser(server, "ada@example.com");
          await createPostWithInternalReference(server, post, authorId);
        }),
        postSteps.ingest(),
        postSteps.assert(({ frontend }) => {
          assert(authorId);
          expect(frontend.collection.get(post.id)).toMatchObject({
            ...post,
            authorId: authorId.externalId,
          });
        }),
        postSteps.reload(),
        postSteps.assert(({ frontend }) => {
          assert(authorId);
          expect(frontend.collection.get(post.id)?.authorId).toBe(authorId.externalId);
        }),
      ],
    });
  });

  it("preserves a Unicode external ID through ingestion and persistence", async () => {
    const user = { id: "user/你好-🧪", email: "unicode@example.com" };

    await runScenario({
      name: "unicode-external-id",
      schema: referenceSchema,
      table: "users",
      collectionOptions: createUserCollectionOptions,
      steps: [
        userSteps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) => forSchema(referenceSchema).create("users", user))
              .execute();
          });
        }),
        userSteps.ingest(),
        userSteps.reload(),
        userSteps.assert(async ({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          await expect(frontend.readPersistedRows()).resolves.toContainEqual(
            expect.objectContaining({ key: user.id }),
          );
        }),
      ],
    });
  });
});

describe("Fragno outbox value materialization", () => {
  it("preserves dates, JSON, bigint, booleans, null, and binary values", async () => {
    const record = {
      id: "record-1",
      occurredAt: new Date("2025-03-04T05:06:07.000Z"),
      birthday: new Date("1815-12-10T00:00:00.000Z"),
      payload: {
        nested: { enabled: true },
        tags: ["math", "computing"],
        count: 2,
      },
      counter: 9_007_199_254_740_993n,
      enabled: true,
      nickname: null,
      bytes: new Uint8Array([0, 1, 127, 255]),
    };

    await runScenario({
      name: "special-values",
      schema: valueSchema,
      table: "records",
      collectionOptions: createRecordCollectionOptions,
      steps: [
        recordSteps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) => forSchema(valueSchema).create("records", record))
              .execute();
          });
        }),
        recordSteps.ingest(),
        recordSteps.assert(({ frontend }) => {
          expect(frontend.collection.get(record.id)).toMatchObject(record);
        }),
        recordSteps.reload(),
        recordSteps.assert(({ frontend }) => {
          expect(frontend.collection.get(record.id)).toMatchObject(record);
        }),
      ],
    });
  });

  it("materializes database defaults omitted from a create mutation", async () => {
    const beforeCreate = new Date();

    await runScenario({
      name: "database-defaults",
      schema: valueSchema,
      table: "defaults",
      collectionOptions: createDefaultCollectionOptions,
      steps: [
        defaultSteps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) =>
                forSchema(valueSchema).create("defaults", {
                  id: "default-1",
                  label: "Generated",
                }),
              )
              .execute();
          });
        }),
        defaultSteps.ingest(),
        defaultSteps.assert(({ frontend }) => {
          const row = frontend.collection.get("default-1");
          expect(row).toMatchObject({
            id: "default-1",
            label: "Generated",
            count: 0,
            enabled: true,
            createdAt: expect.any(Date),
          });
          assert(row);
          expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
        }),
        defaultSteps.reload(),
        defaultSteps.assert(({ frontend }) => {
          expect(frontend.collection.get("default-1")?.createdAt).toBeInstanceOf(Date);
        }),
      ],
    });
  });

  it("persists partial updates containing structured and special values", async () => {
    const original = {
      id: "record-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      birthday: new Date("2000-01-01T00:00:00.000Z"),
      payload: { revision: 1 },
      counter: 1n,
      enabled: false,
      nickname: "first",
      bytes: new Uint8Array([1, 2, 3]),
    };
    const updatedAt = new Date("2026-06-07T08:09:10.000Z");

    await runScenario({
      name: "special-value-update",
      schema: valueSchema,
      table: "records",
      collectionOptions: createRecordCollectionOptions,
      steps: [
        recordSteps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) => forSchema(valueSchema).create("records", original))
              .execute();
          });
        }),
        recordSteps.ingest(),
        recordSteps.server(async ({ server }) => {
          await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
            await this.handlerTx()
              .mutate(({ forSchema }) =>
                forSchema(valueSchema).update("records", original.id, (update) =>
                  update.set({
                    occurredAt: updatedAt,
                    payload: { revision: 2, nested: ["a", "b"] },
                    counter: 2n,
                    enabled: true,
                    nickname: null,
                    bytes: new Uint8Array([4, 5, 6]),
                  }),
                ),
              )
              .execute();
          });
        }),
        recordSteps.ingest(),
        recordSteps.assert(({ frontend }) => {
          expect(frontend.collection.get(original.id)).toMatchObject({
            ...original,
            occurredAt: updatedAt,
            payload: { revision: 2, nested: ["a", "b"] },
            counter: 2n,
            enabled: true,
            nickname: null,
            bytes: new Uint8Array([4, 5, 6]),
          });
        }),
        recordSteps.reload(),
        recordSteps.assert(({ frontend }) => {
          expect(frontend.collection.get(original.id)).toMatchObject({
            ...original,
            occurredAt: updatedAt,
            payload: { revision: 2, nested: ["a", "b"] },
            counter: 2n,
            enabled: true,
            nickname: null,
            bytes: new Uint8Array([4, 5, 6]),
          });
        }),
      ],
    });
  });
});
