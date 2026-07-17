import { afterAll, assert, describe, expect, it } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { authFragmentDefinition } from ".";
import { organizationRoutesFactory } from "./organization/routes";
import { authSchema } from "./schema";
import { sessionRoutesFactory } from "./session/session";
import { userActionsRoutesFactory } from "./user/user-actions";

const authHeaders = (token: string) => ({
  Cookie: `fragno_auth=${token}`,
});

const preOrganizationSchemaVersion = (() => {
  const sessionActiveOrganizationIndex = authSchema.operations.findIndex(
    (operation) =>
      operation.type === "alter-table" &&
      operation.tableName === "session" &&
      operation.operations.some(
        (tableOperation) =>
          tableOperation.type === "add-column" &&
          tableOperation.columnName === "activeOrganizationId",
      ),
  );
  const organizationTableIndex = authSchema.operations.findIndex(
    (operation) => operation.type === "add-table" && operation.tableName === "organization",
  );

  if (sessionActiveOrganizationIndex === -1 || organizationTableIndex === -1) {
    throw new Error(
      "Expected auth schema to include session and organization bootstrap operations.",
    );
  }
  if (organizationTableIndex <= sessionActiveOrganizationIndex) {
    throw new Error("Expected organization table to be added after session.activeOrganizationId.");
  }

  return organizationTableIndex + 1;
})();

describe("auth-fragment organization upgrades", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({ organizations: false })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
      { migrateToVersion: preOrganizationSchemaVersion },
    )
    .build();

  const fragment = fragments.auth;
  const sqlAdapter = test.adapter as SqlAdapter;

  const seedLegacyCredential = async () => {
    const userId = "legacy-upgrade-user";
    const credentialToken = "legacy-upgrade-credential";
    const insertedUsers = await sqlAdapter.driver.executeQuery({
      sql: `
        INSERT INTO "user_auth" ("id", "email", "passwordHash", "role")
        VALUES (?, ?, ?, ?)
        RETURNING "_internalId"
      `,
      parameters: [userId, "upgrade-user@test.com", "legacy-password-hash", "user"],
    });
    const insertedUser = insertedUsers.rows[0] as { _internalId: number | bigint } | undefined;
    assert(insertedUser);

    await sqlAdapter.driver.executeQuery({
      sql: `
        INSERT INTO "session_auth" ("id", "userId", "expiresAt")
        VALUES (?, ?, ?)
      `,
      parameters: [
        credentialToken,
        insertedUser._internalId,
        new Date("2100-01-01T00:00:00.000Z").getTime(),
      ],
    });

    return credentialToken;
  };

  afterAll(async () => {
    await test.cleanup();
  });

  it("preserves legacy users when enabling organizations after upgrading", async () => {
    // The current fragment is compiled against the latest schema, so legacy data is inserted
    // through the SQLite boundary before the migration adds newer Auth columns and tables.
    const credentialToken = await seedLegacyCredential();

    if (!test.adapter.prepareMigrations) {
      throw new Error("Adapter does not support migrations in upgrade test.");
    }
    const migrations = test.adapter.prepareMigrations(authSchema, "auth");
    await migrations.execute(preOrganizationSchemaVersion, authSchema.version, {
      updateVersionInMigration: false,
    });

    const meBeforeOrganizationsEnabled = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meBeforeOrganizationsEnabled.type === "json");
    assert.equal(meBeforeOrganizationsEnabled.data.user.email, "upgrade-user@test.com");
    expect(meBeforeOrganizationsEnabled.data.organizations).toHaveLength(0);
    expect(meBeforeOrganizationsEnabled.data.activeOrganization).toBeNull();

    const upgradedFragment = instantiate(authFragmentDefinition)
      .withConfig({ organizations: {} })
      .withOptions({ databaseAdapter: test.adapter })
      .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory])
      .build();

    const meAfterUpgrade = await upgradedFragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meAfterUpgrade.type === "json");
    expect(meAfterUpgrade.data.organizations).toHaveLength(0);
    expect(meAfterUpgrade.data.activeOrganization).toBeNull();

    const createResponse = await upgradedFragment.callRoute("POST", "/organizations", {
      headers: authHeaders(credentialToken),
      body: { name: "Upgraded Org", slug: "upgraded-org" },
    });

    assert(createResponse.type === "json");
    const createdOrgId = createResponse.data.organization.id as string;

    const meAfterCreate = await upgradedFragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meAfterCreate.type === "json");
    expect(meAfterCreate.data.organizations).toHaveLength(1);
    expect(meAfterCreate.data.organizations[0]?.organization.id).toBe(createdOrgId);

    const setActiveResponse = await upgradedFragment.callRoute("POST", "/organizations/active", {
      headers: authHeaders(credentialToken),
      body: { organizationId: createdOrgId },
    });

    assert(setActiveResponse.type === "json");

    const meAfterActive = await upgradedFragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meAfterActive.type === "json");
    expect(meAfterActive.data.activeOrganization?.organization.id).toBe(createdOrgId);

    await drainDurableHooks(upgradedFragment);
  });
});
