import { afterAll, assert, describe, expect, it } from "vitest";

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

  afterAll(async () => {
    await test.cleanup();
  });

  it("supports enabling organizations after upgrading", async () => {
    const signUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "upgrade-user@test.com", password: "password" },
    });

    assert(signUpResponse.type === "json");
    const credentialToken = signUpResponse.data.auth.token as string;

    const meBeforeUpgrade = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meBeforeUpgrade.type === "json");
    expect(meBeforeUpgrade.data.organizations).toHaveLength(0);
    expect(meBeforeUpgrade.data.activeOrganization).toBeNull();

    if (!test.adapter.prepareMigrations) {
      throw new Error("Adapter does not support migrations in upgrade test.");
    }
    const migrations = test.adapter.prepareMigrations(authSchema, "auth");
    await migrations.execute(preOrganizationSchemaVersion, authSchema.version, {
      updateVersionInMigration: false,
    });

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
