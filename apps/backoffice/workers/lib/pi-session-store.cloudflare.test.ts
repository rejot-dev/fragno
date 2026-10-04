import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import type { OutboxHarnessDurableObject } from "../vitest-env";
import { DurableObjectSqliteDatabase } from "./pi-session-store";

function sessionStoreObject() {
  const namespace = (
    env as typeof env & {
      OUTBOX_HARNESS: DurableObjectNamespace<OutboxHarnessDurableObject>;
    }
  ).OUTBOX_HARNESS;
  return namespace.getByName(`pi-storage-${crypto.randomUUID()}`);
}

describe("Pi session store SQLite scenarios", () => {
  test("rolls back a checkpoint without rolling back unrelated queued writes", async () => {
    await runInDurableObject(sessionStoreObject(), async (_instance, state) => {
      const database = new DurableObjectSqliteDatabase(state.storage);
      await database.exec("CREATE TABLE checkpoints (value TEXT)");
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opened = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const checkpoint = database.transaction(async (transaction) => {
        await transaction.run("INSERT INTO checkpoints VALUES (?)", "uncommitted");
        entered();
        await held;
        throw new Error("Checkpoint failed");
      });
      await opened;
      const unrelated = database.run("INSERT INTO checkpoints VALUES (?)", "outside");
      const observed = database.all<{ value: string }>("SELECT value FROM checkpoints");
      release();
      await expect(checkpoint).rejects.toThrow("Checkpoint failed");
      await unrelated;
      expect(await observed).toEqual([{ value: "outside" }]);
      const expired = await database.transaction(async (transaction) => transaction);
      await expect(expired.get("SELECT 1")).rejects.toThrow("no longer active");
    });
  });

  test("round-trips blob slices and integers and keeps schema names out of SQL literals", async () => {
    await runInDurableObject(sessionStoreObject(), async (_instance, state) => {
      const database = new DurableObjectSqliteDatabase(state.storage);
      await database.exec("CREATE TABLE entries (label TEXT, body BLOB, number INTEGER)");
      const bytes = new Uint8Array([0, 1, 2, 3]);
      await database.transaction(async (transaction) => {
        await transaction.run(
          "INSERT INTO entries VALUES ('entries', ?, ?)",
          bytes.subarray(1, 3),
          42n,
        );
      });
      const stored = await database.get<{ label: string; body: Uint8Array; number: number }>(
        "SELECT * FROM entries",
      );
      expect(stored).toEqual({ label: "entries", body: new Uint8Array([1, 2]), number: 42 });
      expect(state.storage.sql.exec("SELECT label FROM pi_entries").one()).toEqual({
        label: "entries",
      });
      await expect(
        database.run(
          "INSERT INTO entries VALUES ('overflow', NULL, ?)",
          BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        ),
      ).rejects.toThrow("outside the safe range");
      expect(await database.all("SELECT label FROM entries")).toEqual([{ label: "entries" }]);
    });
  });
});
