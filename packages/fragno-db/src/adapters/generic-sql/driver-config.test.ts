import { describe, expect, it } from "vitest";

import { DatabaseConstraintError, DatabaseTransactionError } from "../../errors";
import {
  BetterSQLite3DriverConfig,
  CloudflareDurableObjectsDriverConfig,
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
  PGLiteDriverConfig,
  SQLocalDriverConfig,
  type DriverConfig,
} from "./driver-config";

const withProps = (message: string, props: Record<string, unknown>) =>
  Object.assign(new Error(message), props);

describe("DriverConfig.normalizeError", () => {
  it.each([
    [new BetterSQLite3DriverConfig(), "better-sqlite3"],
    [new SQLocalDriverConfig(), "sqlocal"],
    [new CloudflareDurableObjectsDriverConfig(), "cloudflare_durable_objects"],
  ] as const)("normalizes sqlite unique errors for %s", (config, _driver) => {
    const normalized = config.normalizeError(
      withProps("UNIQUE constraint failed: users.email", { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    );

    expect(normalized).toBeInstanceOf(DatabaseConstraintError);
    expect(normalized).toMatchObject({ kind: "unique", table: "users", columns: ["email"] });
  });

  it("extracts columns from prefixed sqlite-wasm unique errors", () => {
    const config = new SQLocalDriverConfig();
    const normalized = config.normalizeError(
      withProps(
        "SQLITE_CONSTRAINT_UNIQUE: sqlite3 result code 2067: UNIQUE constraint failed: user_auth.email",
        { resultCode: 2067 },
      ),
    );

    expect(normalized).toMatchObject({
      kind: "unique",
      table: "user_auth",
      columns: ["email"],
    });
  });

  it.each([
    [new BetterSQLite3DriverConfig(), "better-sqlite3"],
    [new SQLocalDriverConfig(), "sqlocal"],
    [new CloudflareDurableObjectsDriverConfig(), "cloudflare_durable_objects"],
  ] as const)("normalizes sqlite foreign-key errors for %s", (config, _driver) => {
    const normalized = config.normalizeError(
      withProps("FOREIGN KEY constraint failed", { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
    );

    expect(normalized).toBeInstanceOf(DatabaseConstraintError);
    expect(normalized).toMatchObject({ kind: "foreign-key" });
  });

  it.each([
    [new NodePostgresDriverConfig(), "pg"],
    [new PGLiteDriverConfig(), "pglite"],
  ] as const)("normalizes postgres unique errors for %s", (config, _driver) => {
    const normalized = config.normalizeError(
      withProps('duplicate key value violates unique constraint "users_email_key"', {
        code: "23505",
        table: "users",
        constraint: "users_email_key",
        detail: "Key (email)=(a@example.com) already exists.",
      }),
    );

    expect(normalized).toBeInstanceOf(DatabaseConstraintError);
    expect(normalized).toMatchObject({
      kind: "unique",
      table: "users",
      constraint: "users_email_key",
      columns: ["email"],
    });
  });

  it.each([
    [new NodePostgresDriverConfig(), "pg"],
    [new PGLiteDriverConfig(), "pglite"],
  ] as const)("normalizes retryable postgres transaction errors for %s", (config, _driver) => {
    const serializationFailure = config.normalizeError(
      withProps("serialization failure", { code: "40001" }),
    );
    const deadlock = config.normalizeError(withProps("deadlock", { code: "40P01" }));
    const unique = config.normalizeError(withProps("unique", { code: "23505" }));

    expect(serializationFailure).toBeInstanceOf(DatabaseTransactionError);
    expect(serializationFailure).toMatchObject({ isRetryable: true });
    expect(deadlock).toBeInstanceOf(DatabaseTransactionError);
    expect(deadlock).toMatchObject({ isRetryable: true });
    expect(unique).toBeInstanceOf(DatabaseConstraintError);
    expect(unique).toMatchObject({ isRetryable: false });
  });

  it("normalizes mysql unique errors", () => {
    const config = new MySQL2DriverConfig();
    const normalized = config.normalizeError(
      withProps("Duplicate entry 'a@example.com' for key 'users.email'", {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      }),
    );

    expect(normalized).toBeInstanceOf(DatabaseConstraintError);
    expect(normalized).toMatchObject({ kind: "unique" });
  });

  it.each([
    ["ER_LOCK_DEADLOCK", 1213, "deadlock"],
    ["ER_LOCK_WAIT_TIMEOUT", 1205, "lock wait timeout"],
  ] as const)("normalizes retryable mysql transaction errors for %s", (code, errno, message) => {
    const config = new MySQL2DriverConfig();

    const byCode = config.normalizeError(withProps(message, { code }));
    const byErrno = config.normalizeError(withProps(message, { errno }));

    expect(byCode).toBeInstanceOf(DatabaseTransactionError);
    expect(byCode).toMatchObject({ isRetryable: true });
    expect(byErrno).toBeInstanceOf(DatabaseTransactionError);
    expect(byErrno).toMatchObject({ isRetryable: true });
  });

  it("keeps unknown errors as regular errors", () => {
    const config: DriverConfig = new MySQL2DriverConfig();
    const error = new Error("unknown");
    expect(config.normalizeError(error)).toBe(error);
  });
});
