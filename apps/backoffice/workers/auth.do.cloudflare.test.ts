import { runInDurableObject } from "cloudflare:test";
import { assert, describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import {
  backofficeAccessTokenCookieName,
  verifyBackofficeJwtRequest,
} from "@/fragno/auth/token-lifecycle";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";

import type { AuthSqlHarnessDurableObject } from "./vitest-env";

type AuthSqlHarnessEnv = typeof env & {
  AUTH_SQL_HARNESS: DurableObjectNamespace<AuthSqlHarnessDurableObject>;
};

const getHarness = (name: string) => {
  const namespace = (env as AuthSqlHarnessEnv).AUTH_SQL_HARNESS;
  return namespace.get(namespace.idFromName(name));
};

const cookieHeader = (response: Response): string =>
  getSetCookieHeaders(response.headers)
    .map((header) => header.split(";", 1)[0])
    .join("; ");

const authRequest = (
  stub: DurableObjectStub<AuthSqlHarnessDurableObject>,
  path: string,
  input: { cookie?: string; body?: unknown } = {},
) =>
  stub.fetch(`https://backoffice.example/api/auth${path}`, {
    method: input.body === undefined ? "GET" : "POST",
    headers: {
      origin: "https://backoffice.example",
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

describe("Better Auth Durable Object SQLite", () => {
  test("migrates the schema and persists a complete session lifecycle", async () => {
    const stub = getHarness(`auth-sql-${crypto.randomUUID()}`);

    const signUpResponse = await authRequest(stub, "/sign-up/email", {
      body: {
        name: "SQLite User",
        email: "sqlite-user@example.com",
        password: "password123",
      },
    });
    if (!signUpResponse.ok) {
      assert.fail(await signUpResponse.text());
    }
    const cookie = cookieHeader(signUpResponse);
    assert(cookie);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    const organizations = await stub.getAllOrganizations();
    expect(organizations).toHaveLength(1);
    const organizationId = organizations[0]?.id;
    assert(organizationId);

    const tokenResponse = await authRequest(stub, "/backoffice-token", {
      cookie,
      body: { selection: "required", organizationId },
    });
    if (!tokenResponse.ok) {
      assert.fail(await tokenResponse.text());
    }
    expect(await tokenResponse.clone().json()).toMatchObject({
      organization: { id: organizationId },
    });
    const accessTokenCookie = cookieHeader(tokenResponse);
    expect(accessTokenCookie).toContain(`${backofficeAccessTokenCookieName(false)}=`);

    const verification = await verifyBackofficeJwtRequest(
      new Request("https://backoffice.example/api/backoffice/me", {
        headers: { cookie: accessTokenCookie },
      }),
      stub,
    );
    assert(verification.ok);
    expect(verification.payload.organization).toMatchObject({
      id: organizationId,
      slug: "sqlite-users-organization",
    });

    const me = (await stub.getBackofficeMe({
      userId: verification.payload.sub,
      activeOrganizationId: verification.payload.organization?.id ?? null,
    })) as BackofficeMeData | null;
    expect(me?.activeOrganizationId).toBe(organizationId);
    expect(me?.activeOrganization?.organization.id).toBe(organizationId);

    await runInDurableObject(stub, (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((table) => table.name);
      expect(tables).toEqual(
        expect.arrayContaining(["user", "session", "account", "organization", "member"]),
      );
      const sessionColumns = state.storage.sql
        .exec<{ name: string }>('PRAGMA table_info("session")')
        .toArray()
        .map((column) => column.name);
      expect(sessionColumns).toContain("activeOrganizationId");
    });
  });

  test("reinitializes without rerunning migrations against persisted account state", async () => {
    const stub = getHarness(`auth-restart-account-${crypto.randomUUID()}`);

    const signUpResponse = await authRequest(stub, "/sign-up/email", {
      body: {
        name: "Restart User",
        email: "restart-user@example.com",
        password: "password123",
      },
    });
    if (!signUpResponse.ok) {
      assert.fail(await signUpResponse.text());
    }
    const cookie = cookieHeader(signUpResponse);
    assert(cookie);

    await stub.reinitializeAuth();

    const sessionResponse = await authRequest(stub, "/get-session", { cookie });
    if (!sessionResponse.ok) {
      assert.fail(await sessionResponse.text());
    }
    expect(await sessionResponse.json()).toMatchObject({
      user: { email: "restart-user@example.com" },
    });
  });

  test("records organization state changes through SQLite triggers", async () => {
    const stub = getHarness(`auth-outbox-${crypto.randomUUID()}`);
    await stub.getAllOrganizations();

    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO organization
          (id, name, slug, logo, metadata, createdAt, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "org-trigger",
        "Trigger Organization",
        "trigger-organization",
        null,
        JSON.stringify({ source: "test" }),
        now,
        "user-trigger",
      );

      const created = state.storage.sql
        .exec<{
          id: string;
          hookName: string;
          payload: string;
          status: string;
        }>(
          `SELECT id, hookName, payload, status
           FROM better_auth_hooks
           ORDER BY createdAt, id`,
        )
        .toArray();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        id: "organization.created:org-trigger",
        hookName: "onOrganizationCreated",
        status: "pending",
      });
      expect(JSON.parse(created[0]?.payload ?? "{}")).toMatchObject({
        organization: {
          id: "org-trigger",
          name: "Trigger Organization",
          metadata: { source: "test" },
          createdBy: "user-trigger",
        },
        actor: null,
      });

      state.storage.sql.exec(
        "UPDATE organization SET name = ? WHERE id = ?",
        "Updated Organization",
        "org-trigger",
      );
      state.storage.sql.exec("UPDATE organization SET name = name WHERE id = ?", "org-trigger");

      const events = state.storage.sql
        .exec<{ hookName: string }>("SELECT hookName FROM better_auth_hooks ORDER BY createdAt, id")
        .toArray();
      expect(events).toEqual([
        { hookName: "onOrganizationCreated" },
        { hookName: "onOrganizationUpdated" },
        { hookName: "onOrganizationUpdated" },
      ]);
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    await runInDurableObject(stub, (_instance, state) => {
      const statuses = state.storage.sql
        .exec<{ status: string }>("SELECT status FROM better_auth_hooks ORDER BY createdAt, id")
        .toArray();
      expect(statuses).toEqual([
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
      ]);
    });
  });

  test("drains bounded batches and removes retained terminal events", async () => {
    const stub = getHarness(`auth-outbox-batch-${crypto.randomUUID()}`);
    await stub.getAllOrganizations();

    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < 30; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO organization
            (id, name, slug, logo, metadata, createdAt, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          `org-batch-${index}`,
          `Batch Organization ${index}`,
          `batch-organization-${index}`,
          null,
          null,
          Date.now(),
          "user-batch",
        );
      }
      state.storage.sql.exec(
        `INSERT INTO better_auth_hooks (
          id, hookName, payload, status, attempts, maxAttempts,
          lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
        ) VALUES (?, ?, ?, 'completed', 1, 10, 0, NULL, NULL, 0, NULL)`,
        "organization.updated:retained",
        "onOrganizationUpdated",
        "{}",
      );
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
      await instance.alarm();
    });
    await runInDurableObject(stub, (_instance, state) => {
      const statuses = state.storage.sql
        .exec<{ status: string; count: number }>(
          `SELECT status, COUNT(*) AS count
           FROM better_auth_hooks
           GROUP BY status
           ORDER BY status`,
        )
        .toArray();
      expect(statuses).toEqual([{ status: "completed", count: 30 }]);
    });
  });

  test("rolls back an organization insert when durable event intent cannot be recorded", async () => {
    const stub = getHarness(`auth-outbox-rollback-${crypto.randomUUID()}`);
    await stub.getAllOrganizations();

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_better_auth_hook
        BEFORE INSERT ON better_auth_hooks
        BEGIN
          SELECT RAISE(ABORT, 'outbox unavailable');
        END
      `);

      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO organization
            (id, name, slug, logo, metadata, createdAt, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "org-rollback",
          "Rollback Organization",
          "rollback-organization",
          null,
          null,
          Date.now(),
          "user-rollback",
        ),
      ).toThrow("outbox unavailable");

      const organizations = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM organization WHERE id = ?",
          "org-rollback",
        )
        .one();
      assert(organizations.count === 0);
    });
  });
});
