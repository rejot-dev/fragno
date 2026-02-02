import { SQLocalKysely } from "sqlocal/kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { SqlAdapter } from "./generic-sql-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { SQLocalDriverConfig } from "./driver-config";

describe("SqlAdapter SQLite", () => {
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

  let adapter: SqlAdapter;

  beforeAll(async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    adapter = new SqlAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
    });

    // Run migrations
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test");
    await preparedMigrations.execute(0, testSchema.version, { updateVersionInMigration: false });
  });

  it("should perform a balance transfer between accounts", async () => {
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

  it("should execute Unit of Work with version checking", async () => {
    // Use the same namespace as the first test (migrations already ran)
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial account
    const initialAccountId = await queryEngine.create("accounts", {
      userId: "user3",
      balance: 1000,
    });

    expect(initialAccountId.version).toBe(0);

    // Build a UOW to update the account with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-account-balance")
      // Retrieval phase: find the account
      .find("accounts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialAccountId)));

    // Execute retrieval and transition to mutation phase
    const [accounts] = await uow.executeRetrieve();

    // Mutation phase: update with version check
    uow.update("accounts", initialAccountId, (b) => b.set({ balance: 1500 }).check());

    // Execute mutations
    const { success } = await uow.executeMutations();

    // Should succeed
    expect(success).toBe(true);
    expect(accounts).toHaveLength(1);

    // Verify the account was updated
    const updatedAccount = await queryEngine.findFirst("accounts", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", initialAccountId)),
    );

    expect(updatedAccount).toMatchObject({
      id: expect.objectContaining({
        externalId: initialAccountId.externalId,
        version: 1, // Version incremented
      }),
      userId: "user3",
      balance: 1500,
    });

    // Try to update again with stale version (simulating concurrent update - should fail)
    const uow2 = queryEngine.createUnitOfWork("update-account-stale");

    // Use the old version (0) which is now stale
    uow2.update("accounts", initialAccountId, (b) => b.set({ balance: 2000 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify the account was NOT updated
    const [[unchangedAccount]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("accounts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialAccountId)))
      .executeRetrieve();

    expect(unchangedAccount).toMatchObject({
      id: expect.objectContaining({
        version: 1, // Still version 1
      }),
      balance: 1500, // Still 1500, not 2000
    });
  });
});
