import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type InternalFragmentInstance } from "@fragno-dev/db";
import { schema, idColumn, column, referenceColumn, FragnoReference } from "@fragno-dev/db/schema";
import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "./db-test";
import type { SupportedAdapter } from "./adapters";
import superjson, { type SuperJSONResult } from "superjson";

const outboxSchema = schema((s) => {
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

const outboxFragmentDef = defineFragment("outbox-test").extend(withDatabase(outboxSchema)).build();

async function buildOutboxTest(adapterConfig: SupportedAdapter) {
  return buildDatabaseFragmentsTest()
    .withTestAdapter(adapterConfig)
    .withFragment("outbox", instantiate(outboxFragmentDef).withConfig({}).withRoutes([]))
    .build();
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

const adapterConfigs = [{ type: "kysely-sqlite" as const }, { type: "kysely-pglite" as const }];

describe("Fragno DB Outbox", () => {
  it("does not write outbox entries when disabled", async () => {
    const { fragments, test } = await buildOutboxTest({ type: "kysely-sqlite" });
    const { fragment, db } = fragments.outbox;
    const internalFragment = fragment.$internal.linkedFragments._fragno_internal;

    await db.create("users", { email: "disabled@example.com" });

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(0);

    await test.cleanup();
  });

  it("stores refMap placeholders and lists entries in order", async () => {
    const { fragments, test } = await buildOutboxTest({
      type: "kysely-sqlite",
      outbox: { enabled: true },
    });
    const { fragment, db } = fragments.outbox;
    const internalFragment = fragment.$internal.linkedFragments._fragno_internal;

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

    const filtered = await listOutbox(internalFragment, {
      afterVersionstamp: entries[0].versionstamp,
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].versionstamp).toBe(entries[1].versionstamp);

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

    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [
          internalFragment.services.settingsService.set("outbox-test", "noop", "1"),
        ])
        .execute();
    });

    const afterInternal = await listOutbox(internalFragment);
    expect(afterInternal).toHaveLength(2);

    await test.cleanup();
  });

  it("orders outbox entries by commit order across concurrent UOWs", async () => {
    const { fragments, test } = await buildOutboxTest({
      type: "kysely-sqlite",
      outbox: { enabled: true },
    });
    const { fragment, db } = fragments.outbox;
    const internalFragment = fragment.$internal.linkedFragments._fragno_internal;

    const uow1 = db.createUnitOfWork("uow-1");
    const uow2 = db.createUnitOfWork("uow-2");
    const uow1Id = uow1.idempotencyKey;
    const uow2Id = uow2.idempotencyKey;

    uow1.create("users", { email: "order-1@example.com" });
    uow2.create("users", { email: "order-2@example.com" });

    const completionOrder: string[] = [];
    await Promise.all([
      uow1.executeMutations().then(() => completionOrder.push(uow1Id)),
      uow2.executeMutations().then(() => completionOrder.push(uow2Id)),
    ]);

    const entries = await listOutbox(internalFragment);
    expect(entries.map((entry) => entry.uowId)).toEqual(completionOrder);
    expect(entries[0].versionstamp < entries[1].versionstamp).toBe(true);

    await test.cleanup();
  });

  describe.each(adapterConfigs)("adapter opt-in (%s)", (adapterConfig) => {
    it("writes outbox rows only when enabled", async () => {
      const { fragments, test } = await buildOutboxTest(adapterConfig);
      const { fragment, db } = fragments.outbox;
      const internalFragment = fragment.$internal.linkedFragments._fragno_internal;

      await db.create("users", { email: "disabled@example.com" });
      const disabledEntries = await listOutbox(internalFragment);
      expect(disabledEntries).toHaveLength(0);
      await test.cleanup();

      const { fragments: enabledFragments, test: enabledTest } = await buildOutboxTest({
        ...adapterConfig,
        outbox: { enabled: true },
      });
      const enabledInternal =
        enabledFragments.outbox.fragment.$internal.linkedFragments._fragno_internal;
      await enabledFragments.outbox.db.create("users", { email: "enabled@example.com" });
      const enabledEntries = await listOutbox(enabledInternal);
      expect(enabledEntries).toHaveLength(1);
      await enabledTest.cleanup();
    });
  });
});
