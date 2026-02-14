import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import superjson, { type SuperJSONResult } from "superjson";
import type { AnyFragnoInstantiatedDatabaseFragment, DatabaseRequestContext } from "../../mod";
import type { SimpleQueryInterface } from "../../query/simple-query-interface";
import { withDatabase } from "../../with-database";
import { schema, idColumn, column, referenceColumn, FragnoReference } from "../../schema/create";
import type { OutboxEntry, OutboxPayload } from "../../outbox/outbox";
import type { InternalFragmentInstance } from "../../fragments/internal-fragment";
import { internalSchema } from "../../fragments/internal-fragment";
import { getInternalFragment } from "../../internal/adapter-registry";
import { InMemoryAdapter, type InMemoryUowConfig } from "./in-memory-adapter";

const buildOutboxSchema = () =>
  schema("outbox", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("email", column("string"))
          .createIndex("idx_users_email", ["email"], { unique: true });
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("authorId", referenceColumn())
          .addColumn("title", column("string"));
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "authorId" },
        to: { table: "users", column: "id" },
      });
  });

const outboxSchema = buildOutboxSchema();

const outboxFragmentName = "outbox-in-memory-test";
const outboxFragmentDef = defineFragment(outboxFragmentName)
  .extend(withDatabase(outboxSchema))
  .build();

type OutboxTestContext = {
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>;
  internalFragment: InternalFragmentInstance;
  internalDb: SimpleQueryInterface<typeof internalSchema, InMemoryUowConfig>;
  cleanup: () => Promise<void>;
};

async function buildOutboxTest(options: { outboxEnabled?: boolean }): Promise<OutboxTestContext> {
  const adapter = new InMemoryAdapter({
    idSeed: "outbox-seed",
  });

  const fragment = instantiate(outboxFragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      databaseAdapter: adapter,
      outbox: options.outboxEnabled ? { enabled: true } : undefined,
    })
    .build();

  return {
    fragment,
    internalFragment: getInternalFragment(adapter),
    internalDb: adapter.createQueryEngine(internalSchema, null),
    cleanup: async () => {
      await adapter.close();
    },
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
  shardOptions?: { shard?: string | null; shardScope?: "scoped" | "global" },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function (this: DatabaseRequestContext) {
    if (shardOptions?.shardScope) {
      this.setShardScope(shardOptions.shardScope);
    }
    if (shardOptions && "shard" in shardOptions) {
      this.setShard(shardOptions.shard ?? null);
    }
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

async function assignOutboxShards(
  internalDb: SimpleQueryInterface<typeof internalSchema, InMemoryUowConfig>,
  shards: Array<string | null>,
): Promise<void> {
  const entries = await internalDb.find("fragno_db_outbox", (b) =>
    b.whereIndex("idx_outbox_versionstamp").orderByIndex("idx_outbox_versionstamp", "asc"),
  );

  const shardByVersion = new Map<string, string | null>();
  for (const [index, entry] of entries.entries()) {
    const shard = shards[index] ?? null;
    shardByVersion.set(entry.versionstamp, shard);
    await internalDb.update("fragno_db_outbox", entry.id, (b) =>
      b.set({ _shard: shard } as Record<string, unknown>),
    );
  }

  const mutations = await internalDb.find("fragno_db_outbox_mutations", (b) =>
    b.whereIndex("idx_outbox_mutations_entry").orderByIndex("idx_outbox_mutations_entry", "asc"),
  );

  for (const mutation of mutations) {
    const shard = shardByVersion.get(mutation.entryVersionstamp) ?? null;
    await internalDb.update("fragno_db_outbox_mutations", mutation.id, (b) =>
      b.set({ _shard: shard } as Record<string, unknown>),
    );
  }
}

async function listOutboxMutations(
  internalDb: SimpleQueryInterface<typeof internalSchema, InMemoryUowConfig>,
): Promise<
  Array<{
    entryVersionstamp: string;
    mutationVersionstamp: string;
    uowId: string;
    schema: string;
    table: string;
    externalId: string;
    op: string;
  }>
> {
  return await internalDb.find("fragno_db_outbox_mutations", (b) =>
    b.whereIndex("idx_outbox_mutations_entry").orderByIndex("idx_outbox_mutations_entry", "asc"),
  );
}

async function createUser(
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>,
  email: string,
) {
  return fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(outboxSchema).create("users", { email }))
      .execute();

    const user = await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(outboxSchema).findFirst("users", (b) =>
          b.whereIndex("idx_users_email", (eb) => eb("email", "=", email)),
        ),
      )
      .transformRetrieve(([result]) => result)
      .execute();

    if (!user) {
      throw new Error("Expected user to be created.");
    }

    return user.id;
  });
}

async function createPost(
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>,
  title: string,
  authorId: FragnoReference,
) {
  return fragment.inContext(async function (this: DatabaseRequestContext) {
    return await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(outboxSchema).create("posts", { title, authorId }))
      .transform(({ mutateResult }) => mutateResult)
      .execute();
  });
}

describe("in-memory outbox", () => {
  it("persists shard on outbox rows", async () => {
    const { fragment, internalFragment, cleanup } = await buildOutboxTest({
      outboxEnabled: true,
    });

    await fragment.inContext(async function () {
      this.setShard("shard-alpha");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(outboxSchema);
          uow.create("users", { email: "shard-alpha@example.com" });
        })
        .execute();
    });

    const shardEntries = await listOutbox(internalFragment, undefined, { shard: "shard-alpha" });
    expect(shardEntries).toHaveLength(1);

    const otherShardEntries = await listOutbox(internalFragment, undefined, {
      shard: "shard-beta",
    });
    expect(otherShardEntries).toHaveLength(0);

    await cleanup();
  });

  it("does not write outbox entries when disabled", async () => {
    const { fragment, internalFragment, internalDb, cleanup } = await buildOutboxTest({
      outboxEnabled: false,
    });

    await createUser(fragment, "disabled@example.com");

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(0);
    const mutations = await listOutboxMutations(internalDb);
    expect(mutations).toHaveLength(0);

    await cleanup();
  });

  it("stores refMap placeholders and lists entries in order", async () => {
    const { fragment, internalFragment, internalDb, cleanup } = await buildOutboxTest({
      outboxEnabled: true,
    });

    const userId = await createUser(fragment, "alpha@example.com");
    expect(userId.internalId).toBeDefined();

    await createPost(fragment, "Hello", FragnoReference.fromInternal(userId.internalId!));

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(2);
    expect(entries[0].versionstamp < entries[1].versionstamp).toBe(true);

    const payload = superjson.deserialize(entries[1].payload as SuperJSONResult) as OutboxPayload;
    expect(payload.version).toBe(1);
    expect(payload.mutations).toHaveLength(1);
    const [mutation] = payload.mutations;
    if (mutation.op !== "create") {
      throw new Error("Expected create mutation in outbox payload.");
    }
    expect(mutation.values).toMatchObject({
      authorId: { __fragno_ref: "0.authorId" },
    });
    expect(entries[1].refMap).toEqual({
      "0.authorId": userId.externalId,
    });

    await assignOutboxShards(internalDb, ["shard-a", "shard-b"]);

    const shardAEntries = await listOutbox(internalFragment, undefined, { shard: "shard-a" });
    expect(shardAEntries).toHaveLength(1);
    expect(shardAEntries[0].versionstamp).toBe(entries[0].versionstamp);

    const shardBEntries = await listOutbox(internalFragment, undefined, { shard: "shard-b" });
    expect(shardBEntries).toHaveLength(1);
    expect(shardBEntries[0].versionstamp).toBe(entries[1].versionstamp);

    const globalEntries = await listOutbox(internalFragment, undefined, {
      shard: "shard-a",
      shardScope: "global",
    });
    expect(globalEntries).toHaveLength(2);

    await cleanup();
  });

  it("writes mutation log rows for each outbox entry", async () => {
    const { fragment, internalFragment, internalDb, cleanup } = await buildOutboxTest({
      outboxEnabled: true,
    });

    const userId = await createUser(fragment, "log-alpha@example.com");
    expect(userId.internalId).toBeDefined();

    await createPost(fragment, "Log", FragnoReference.fromInternal(userId.internalId!));

    const entries = await listOutbox(internalFragment);
    const mutations = await listOutboxMutations(internalDb);

    expect(entries).toHaveLength(2);
    expect(mutations).toHaveLength(2);

    const entryByVersion = new Map(entries.map((entry) => [entry.versionstamp, entry]));

    for (const entry of entries) {
      const payload = superjson.deserialize(entry.payload as SuperJSONResult) as OutboxPayload;
      expect(payload.mutations).toHaveLength(1);
    }

    for (const mutationRow of mutations) {
      const entry = entryByVersion.get(mutationRow.entryVersionstamp);
      expect(entry).toBeDefined();
      const payload = superjson.deserialize(entry!.payload as SuperJSONResult) as OutboxPayload;
      const mutation = payload.mutations[0];
      expect(mutationRow.mutationVersionstamp).toBe(mutation.versionstamp);
      expect(mutationRow.uowId).toBe(entry!.uowId);
      expect(mutationRow.schema).toBe(mutation.schema);
      expect(mutationRow.table).toBe(mutation.table);
      expect(mutationRow.externalId).toBe(mutation.externalId);
      expect(mutationRow.op).toBe(mutation.op);
    }

    await cleanup();
  });

  it("resolves refMap lookups within the correct namespace", async () => {
    const adapter = new InMemoryAdapter({
      idSeed: "outbox-seed",
    });

    try {
      const schemaA = buildOutboxSchema();
      const schemaB = buildOutboxSchema();

      const fragmentDefA = defineFragment(`${outboxFragmentName}-a`)
        .extend(withDatabase(schemaA))
        .build();
      const fragmentDefB = defineFragment(`${outboxFragmentName}-b`)
        .extend(withDatabase(schemaB))
        .build();

      const fragmentA = instantiate(fragmentDefA)
        .withConfig({})
        .withRoutes([])
        .withOptions({
          databaseAdapter: adapter,
          databaseNamespace: "tenant-a",
          outbox: { enabled: true },
        })
        .build();
      const fragmentB = instantiate(fragmentDefB)
        .withConfig({})
        .withRoutes([])
        .withOptions({
          databaseAdapter: adapter,
          databaseNamespace: "tenant-b",
          outbox: { enabled: true },
        })
        .build();

      const userA = await fragmentA.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(schemaA).create("users", { email: "tenant-a@example.com" }),
          )
          .execute();

        const user = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(schemaA).findFirst("users", (b) =>
              b.whereIndex("idx_users_email", (eb) => eb("email", "=", "tenant-a@example.com")),
            ),
          )
          .transformRetrieve(([result]) => result)
          .execute();

        if (!user) {
          throw new Error("Expected user to be created.");
        }

        return user.id;
      });

      const userB = await fragmentB.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(schemaB).create("users", { email: "tenant-b@example.com" }),
          )
          .execute();

        const user = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(schemaB).findFirst("users", (b) =>
              b.whereIndex("idx_users_email", (eb) => eb("email", "=", "tenant-b@example.com")),
            ),
          )
          .transformRetrieve(([result]) => result)
          .execute();

        if (!user) {
          throw new Error("Expected user to be created.");
        }

        return user.id;
      });

      expect(userA.internalId).toBeDefined();
      expect(userB.internalId).toBeDefined();
      expect(userA.internalId).toBe(userB.internalId);

      await fragmentB.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(schemaB).create("posts", {
              title: "Hello",
              authorId: FragnoReference.fromInternal(userB.internalId!),
            }),
          )
          .execute();
      });

      const entries = await listOutbox(getInternalFragment(adapter));
      let postEntry: OutboxEntry | undefined;
      let postPayload: OutboxPayload | undefined;

      for (const entry of entries) {
        const payload = superjson.deserialize(entry.payload as SuperJSONResult) as OutboxPayload;
        if (
          payload.mutations.some(
            (mutation) =>
              mutation.op === "create" &&
              mutation.table === "posts" &&
              mutation.namespace === "tenant-b",
          )
        ) {
          postEntry = entry;
          postPayload = payload;
          break;
        }
      }

      if (!postEntry || !postPayload) {
        throw new Error("Expected outbox entry for tenant-b posts.");
      }

      expect(postEntry.refMap).toEqual({
        "0.authorId": userB.externalId,
      });
    } finally {
      await adapter.close();
    }
  });
});
