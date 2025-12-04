import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";

describe("KyselyAdapter SQLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("accounts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("userId", column("string"))
          .addColumn("balance", column("integer"))
          .createIndex("idx_user", ["userId"]);
      })
      .addTable("transactions", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("fromAccountId", referenceColumn())
          .addColumn("toAccountId", referenceColumn())
          .addColumn("amount", column("integer"));
      })
      .addReference("fromAccount", {
        type: "one",
        from: { table: "transactions", column: "fromAccountId" },
        to: { table: "accounts", column: "id" },
      })
      .addReference("toAccount", {
        type: "one",
        from: { table: "transactions", column: "toAccountId" },
        to: { table: "accounts", column: "id" },
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let adapter: KyselyAdapter;

  beforeAll(async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "sqlite",
    });

    // Run migrations
    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration({
      updateSettings: false,
    });
    await preparedMigration.execute();
  });

  // TODO(Wilco): The SQLocal adapter does not return the number of affected rows for updates/deletes.
  //              (this only seems to happens when the query is compiled and then executed with executeQuery())
  it.todo("should perform a balance transfer between accounts", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create two accounts with initial balances
    const account1Id = await queryEngine.create("accounts", {
      userId: "user1",
      balance: 1000,
    });

    const account2Id = await queryEngine.create("accounts", {
      userId: "user2",
      balance: 500,
    });

    // Verify initial balances
    const initialAccount1 = await queryEngine.findFirst("accounts", (b) => {
      return b.whereIndex("primary", (eb) => eb("id", "=", account1Id));
    });

    const initialAccount2 = await queryEngine.findFirst("accounts", (b) => {
      return b.whereIndex("primary", (eb) => eb("id", "=", account2Id));
    });

    expect(initialAccount1?.balance).toBe(1000);
    expect(initialAccount2?.balance).toBe(500);

    // Perform a balance transfer using Unit of Work
    const transferAmount = 300;

    // Read current balances - chain the calls to properly set generics
    const uow = queryEngine
      .createUnitOfWork("balance-transfer")
      .find("accounts", (b) => {
        return b.whereIndex("primary", (eb) => eb("id", "=", account1Id));
      })
      .find("accounts", (b) => {
        return b.whereIndex("primary", (eb) => eb("id", "=", account2Id));
      });

    // Execute retrieval phase
    const [[fromAccount], [toAccount]] = await uow.executeRetrieve();

    expect(fromAccount).toBeDefined();
    expect(toAccount).toBeDefined();

    // Mutation phase: update balances and record transaction
    uow.update("accounts", account1Id, (b) => {
      return b.set({ balance: fromAccount!.balance - transferAmount }).check();
    });

    uow.update("accounts", account2Id, (b) => {
      return b.set({ balance: toAccount!.balance + transferAmount }).check();
    });

    uow.create("transactions", {
      fromAccountId: account1Id,
      toAccountId: account2Id,
      amount: transferAmount,
    });

    // Execute mutations
    const { success } = await uow.executeMutations();
    expect(success).toBe(true);

    // Verify final balances
    const finalAccount1 = await queryEngine.findFirst("accounts", (b) => {
      return b.whereIndex("primary", (eb) => eb("id", "=", account1Id));
    });

    const finalAccount2 = await queryEngine.findFirst("accounts", (b) => {
      return b.whereIndex("primary", (eb) => eb("id", "=", account2Id));
    });

    expect(finalAccount1?.balance).toBe(700); // 1000 - 300
    expect(finalAccount2?.balance).toBe(800); // 500 + 300

    // Verify versions were incremented
    expect(finalAccount1?.id.version).toBe(1);
    expect(finalAccount2?.id.version).toBe(1);

    // Verify transaction was recorded
    const transaction = await queryEngine.findFirst("transactions", (b) => {
      return b.whereIndex("primary");
    });

    expect(transaction).toMatchObject({
      fromAccountId: expect.objectContaining({
        internalId: account1Id.internalId,
      }),
      toAccountId: expect.objectContaining({
        internalId: account2Id.internalId,
      }),
      amount: transferAmount,
    });
  });
});
