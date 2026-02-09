import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import superjson, { type SuperJSONResult } from "superjson";
import type { SimpleQueryInterface } from "../../query/simple-query-interface";
import { withDatabase } from "../../with-database";
import { schema, idColumn, column, referenceColumn, FragnoReference } from "../../schema/create";
import type { OutboxEntry, OutboxPayload } from "../../outbox/outbox";
import type { InternalFragmentInstance } from "../../fragments/internal-fragment";
import { getInternalFragment } from "../../internal/adapter-registry";
import { InMemoryAdapter } from "./in-memory-adapter";

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
  db: SimpleQueryInterface<typeof outboxSchema>;
  internalFragment: InternalFragmentInstance;
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

  const deps = fragment.$internal.deps as { db: SimpleQueryInterface<typeof outboxSchema> };

  return {
    db: deps.db,
    internalFragment: getInternalFragment(adapter),
    cleanup: async () => {
      await adapter.close();
    },
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function () {
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

describe("in-memory outbox", () => {
  it("does not write outbox entries when disabled", async () => {
    const { db, internalFragment, cleanup } = await buildOutboxTest({ outboxEnabled: false });

    await db.create("users", { email: "disabled@example.com" });

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(0);

    await cleanup();
  });

  it("stores refMap placeholders and lists entries in order", async () => {
    const { db, internalFragment, cleanup } = await buildOutboxTest({ outboxEnabled: true });

    await db.create("users", { email: "alpha@example.com" });
    const user = await db.findFirst("users", (b) =>
      b.whereIndex("idx_users_email", (eb) => eb("email", "=", "alpha@example.com")),
    );
    expect(user).not.toBeNull();
    expect(user?.id.internalId).toBeDefined();

    await db.create("posts", {
      title: "Hello",
      authorId: FragnoReference.fromInternal(user!.id.internalId!),
    });

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
      "0.authorId": user!.id.externalId,
    });

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

      const depsA = fragmentA.$internal.deps as { db: SimpleQueryInterface<typeof schemaA> };
      const depsB = fragmentB.$internal.deps as { db: SimpleQueryInterface<typeof schemaB> };

      const userA = await depsA.db.create("users", { email: "tenant-a@example.com" });
      const userB = await depsB.db.create("users", { email: "tenant-b@example.com" });

      expect(userA.internalId).toBeDefined();
      expect(userB.internalId).toBeDefined();
      expect(userA.internalId).toBe(userB.internalId);

      await depsB.db.create("posts", {
        title: "Hello",
        authorId: FragnoReference.fromInternal(userB.internalId!),
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
