import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createProjectConnectorFragmentClient } from "./client/vanilla";
import { projectConnectorFragmentDefinition } from "./definition";
import {
  projectConnectorConnectionSchema,
  projectConnectorNamedRequestSchema,
} from "./project-connector-contracts";
import { projectConnectorRoutes } from "./routes";
import { projectConnectorSchema } from "./schema";
import { startProjectConnectorTestGateway } from "./testing/project-connector-test-gateway";

const cleanup: (() => Promise<void>)[] = [];
const returnUri = "http://localhost/connected";

async function connectorScenario(
  catalogApiKey: string | null = "test-catalog-key",
  schemaVersion: number = projectConnectorSchema.version,
) {
  const gateway = await startProjectConnectorTestGateway();
  cleanup.push(gateway.close);
  const onConnectionReadinessChanged = vi.fn();
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "connector",
      instantiate(projectConnectorFragmentDefinition)
        .withConfig({
          baseUrl: gateway.baseUrl,
          apiKey: "test-project-key",
          catalogApiKey,
          getExternalUserId: (headers) => headers.get("x-test-user"),
          allowedReturnUrls: (url) => url.toString() === returnUri,
          onConnectionReadinessChanged,
        })
        .withRoutes([projectConnectorRoutes]),
      { migrateToVersion: schemaVersion },
    )
    .build();
  cleanup.push(() => setup.test.cleanup());
  const { fragment, db } = setup.fragments.connector;
  async function call(
    externalUserId: string | null,
    method: "GET" | "POST",
    route: string,
    body: unknown = null,
  ) {
    const headers = new Headers({ "content-type": "application/json" });
    if (externalUserId) {
      headers.set("x-test-user", externalUserId);
    }
    const currentFragment = setup.fragments.connector.fragment;
    const response = await currentFragment.handler(
      new Request(`http://localhost${currentFragment.mountRoute}${route}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
    );
    assert(response);
    return { status: response.status, data: (await response.json()) as unknown };
  }
  async function connect(externalUserId: string, connectionName = "work") {
    const response = await call(externalUserId, "POST", "/connection-requests", {
      service: "gmail",
      connectionName,
      returnUri,
    });
    assert(response.status === 200);
    return projectConnectorConnectionSchema.parse(response.data);
  }
  async function bind(externalUserId: string, accountId: string, connectionName = "work") {
    const connection = await connect(externalUserId, connectionName);
    gateway.authorize(connection.id, accountId);
    const result = await call(
      externalUserId,
      "POST",
      `/connection-requests/${connection.id}/refresh`,
    );
    assert(result.status === 200);
    return connection;
  }
  async function storedRequest(requestId: string) {
    const [saved] = await db
      .createUnitOfWork("read-saved-request")
      .forSchema(projectConnectorSchema)
      .findFirst("connectionRequest", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", requestId)),
      )
      .executeRetrieve();
    assert(saved);
    return saved;
  }
  async function readinessChanges() {
    await drainDurableHooks(setup.fragments.connector.fragment);
    return onConnectionReadinessChanged.mock.calls.map(([payload]) => payload);
  }
  return { gateway, setup, fragment, db, call, connect, bind, storedRequest, readinessChanges };
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

describe("Project Connector connection scenarios", () => {
  test("authenticated discovery updates the client store and selects an exact OAuth configuration", async () => {
    const scenario = await connectorScenario();
    expect(await scenario.call(null, "GET", "/provider-configs")).toMatchObject({
      status: 401,
      data: { code: "UNAUTHENTICATED" },
    });
    assert(scenario.gateway.control.discoveryReads === 0);
    const [workConfig] = scenario.gateway.providerConfigs;
    assert(workConfig);
    const { actionIds, ...workOverview } = workConfig;
    scenario.gateway.providerConfigs.push({
      ...workConfig,
      id: "gmail-personal",
      displayName: "Personal Gmail",
    });
    const client = createProjectConnectorFragmentClient({
      baseUrl: "http://localhost",
      fetcherConfig: {
        type: "function",
        useOnServer: true,
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("x-test-user", "alice");
          const response = await scenario.fragment.handler(request);
          assert(response);
          return response;
        },
      },
    });
    const providerStore = client.useProviderConfigs();
    const unsubscribe = providerStore.subscribe(() => undefined);
    try {
      await expect
        .poll(() => providerStore.get().data)
        .toEqual({
          projectId: "project-1",
          providerConfigs: [
            workOverview,
            { ...workOverview, id: "gmail-personal", displayName: "Personal Gmail" },
          ],
        });
      expect(JSON.stringify(providerStore.get().data)).not.toContain("test-project-key");
      assert(scenario.gateway.requests.size === 0);
      expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
        accounts: [],
        cursor: null,
        hasNextPage: false,
      });
      const selectedConfig = providerStore
        .get()
        .data?.providerConfigs.find((config) => config.id === "gmail-personal");
      assert(selectedConfig);
      expect(
        await scenario.call("alice", "GET", `/provider-configs/${selectedConfig.id}/actions`),
      ).toEqual({
        status: 200,
        data: {
          projectId: "project-1",
          providerConfigId: selectedConfig.id,
          actions: actionIds.map((id) => scenario.gateway.catalogActions.get(id)),
        },
      });
      const started = await client.connect().mutate({
        body: { providerConfigId: selectedConfig.id, connectionName: "personal", returnUri },
      });
      assert(started);
      expect(scenario.gateway.links).toEqual([
        {
          userId: "alice",
          service: "gmail",
          providerConfigId: "gmail-personal",
          alias: "personal",
          returnUri,
        },
      ]);
      scenario.gateway.authorize(started.id, "personal-account");
      await client.refreshConnection().mutate({ path: { requestId: started.id } });
      expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({
        accounts: [{ id: "personal-account", providerConfigId: "gmail-personal" }],
      });
      scenario.gateway.providerConfigs.splice(0);
      expect(await scenario.call("alice", "GET", "/provider-configs")).toEqual({
        status: 200,
        data: { projectId: "project-1", providerConfigs: [] },
      });
    } finally {
      unsubscribe();
    }
  });

  test("action discovery selects one configuration, updates its client store, and distinguishes empty from missing", async () => {
    const scenario = await connectorScenario();
    expect(
      await scenario.call(null, "GET", "/provider-configs/gmail-provider/actions"),
    ).toMatchObject({
      status: 401,
      data: { code: "UNAUTHENTICATED" },
    });
    assert(scenario.gateway.control.discoveryReads === 0);
    const [workConfig] = scenario.gateway.providerConfigs;
    assert(workConfig);
    const personalConfig = {
      ...workConfig,
      id: "gmail-personal",
      displayName: "Personal Gmail",
      actionIds: ["gmail.send_email"],
    };
    scenario.gateway.providerConfigs.push(personalConfig);
    const client = createProjectConnectorFragmentClient({
      baseUrl: "http://localhost",
      fetcherConfig: {
        type: "function",
        useOnServer: true,
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("x-test-user", "alice");
          const response = await scenario.fragment.handler(request);
          assert(response);
          return response;
        },
      },
    });
    const actionsStore = client.useProviderActions({
      path: { providerConfigId: personalConfig.id },
    });
    const unsubscribe = actionsStore.subscribe(() => undefined);
    try {
      await expect
        .poll(() => actionsStore.get().data)
        .toEqual({
          projectId: "project-1",
          providerConfigId: "gmail-personal",
          actions: [scenario.gateway.catalogActions.get("gmail.send_email")],
        });
      expect(JSON.stringify(actionsStore.get().data)).not.toContain("test-project-key");
      expect(JSON.stringify(actionsStore.get().data)).not.toContain("test-catalog-key");
      expect(scenario.gateway.control.catalogReads).toEqual(["gmail"]);
      const discoveryReadsBefore = scenario.gateway.control.discoveryReads;
      personalConfig.actionIds.push("gmail.search_threads", "gmail.send_email");
      expect(
        await scenario.call("alice", "GET", "/provider-configs/gmail-personal/actions"),
      ).toEqual({
        status: 200,
        data: {
          projectId: "project-1",
          providerConfigId: "gmail-personal",
          actions: [
            scenario.gateway.catalogActions.get("gmail.send_email"),
            scenario.gateway.catalogActions.get("gmail.search_threads"),
          ],
        },
      });
      expect(scenario.gateway.control.discoveryReads).toBe(discoveryReadsBefore + 1);
      expect(scenario.gateway.control.catalogReads).toEqual(["gmail", "gmail"]);
      personalConfig.actionIds.splice(0);
      expect(
        await scenario.call("alice", "GET", "/provider-configs/gmail-personal/actions"),
      ).toEqual({
        status: 200,
        data: { projectId: "project-1", providerConfigId: "gmail-personal", actions: [] },
      });
      expect(
        await scenario.call("alice", "GET", "/provider-configs/unknown/actions"),
      ).toMatchObject({
        status: 404,
        data: { code: "PROVIDER_CONFIG_NOT_FOUND" },
      });
      assert(scenario.gateway.requests.size === 0);
      expect(scenario.gateway.executions).toEqual([]);
      expect(scenario.gateway.control.catalogReads).toEqual(["gmail", "gmail"]);
    } finally {
      unsubscribe();
    }
  });

  test.each([
    { catalogApiKey: null, code: "catalog_not_configured" },
    { catalogApiKey: "test-project-key", code: "provider_error" },
  ])(
    "catalog access failure ($code) leaves project authentication and verified accounts usable",
    async ({ catalogApiKey, code }) => {
      const scenario = await connectorScenario(catalogApiKey);
      expect(
        await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions"),
      ).toMatchObject({
        status: 502,
        data: { code: "PROJECT_CONNECTOR_ERROR", message: expect.stringContaining(code) },
      });
      expect(await scenario.call("alice", "GET", "/status")).toMatchObject({
        status: 200,
        data: { authenticated: true },
      });
      await scenario.bind("alice", "alice-account");
      expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({
        accounts: [{ id: "alice-account" }],
      });
      expect(scenario.gateway.control.catalogReads).toEqual([]);
      expect(scenario.gateway.executions).toEqual([]);
    },
  );

  test("catalog redirects are rejected without forwarding credentials, and discovery recovers", async () => {
    const scenario = await connectorScenario();
    scenario.gateway.control.catalogFailure = "redirect";
    const redirected = await scenario.call(
      "alice",
      "GET",
      "/provider-configs/gmail-provider/actions",
    );
    expect(redirected).toMatchObject({
      status: 502,
      data: {
        code: "PROJECT_CONNECTOR_ERROR",
        message: expect.stringContaining("unexpected_redirect (HTTP 302)"),
      },
    });
    expect(JSON.stringify(redirected.data)).not.toContain("test-catalog-key");
    assert((await scenario.call("alice", "GET", "/provider-configs")).status === 200);

    scenario.gateway.control.catalogFailure = null;
    expect(
      await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions"),
    ).toMatchObject({ status: 200, data: { actions: [{ id: "gmail.search_threads" }] } });
    assert(scenario.gateway.control.redirectReads === 0);
    expect(scenario.gateway.control.catalogReads).toEqual(["gmail", "gmail"]);
    expect(scenario.gateway.executions).toEqual([]);
    expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
      accounts: [],
      cursor: null,
      hasNextPage: false,
    });
  });

  test("catalog changes are authoritative, and unavailable or mismatched contracts fail without executing", async () => {
    const scenario = await connectorScenario();
    const action = scenario.gateway.catalogActions.get("gmail.search_threads");
    assert(action);
    action.inputSchema = {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "integer", minimum: 1 } },
      required: ["query"],
    };
    expect(await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions")).toEqual(
      {
        status: 200,
        data: { projectId: "project-1", providerConfigId: "gmail-provider", actions: [action] },
      },
    );
    scenario.gateway.control.catalogFailure = "wrong-service";
    expect(
      await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions"),
    ).toMatchObject({
      status: 502,
      data: {
        code: "PROJECT_CONNECTOR_ERROR",
        message: expect.stringContaining("action_identity_mismatch"),
      },
    });
    scenario.gateway.control.catalogFailure = null;
    action.id = "gmail.send_email";
    expect(
      await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions"),
    ).toMatchObject({
      status: 502,
      data: {
        code: "PROJECT_CONNECTOR_ERROR",
        message: expect.stringContaining("invalid_response"),
      },
    });
    action.id = "gmail.search_threads";
    // An upstream contract regression must not be converted to a permissive schema.
    Reflect.deleteProperty(action, "outputSchema");
    expect(
      await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions"),
    ).toMatchObject({
      status: 502,
      data: {
        code: "PROJECT_CONNECTOR_ERROR",
        message: expect.stringContaining("invalid_response"),
      },
    });
    scenario.gateway.catalogActions.delete(action.id);
    const missing = await scenario.call("alice", "GET", "/provider-configs/gmail-provider/actions");
    expect(missing).toMatchObject({
      status: 502,
      data: {
        code: "PROJECT_CONNECTOR_ERROR",
        message: expect.stringContaining("action_not_found"),
      },
    });
    expect(JSON.stringify(missing.data)).not.toContain("test-catalog-key");
    expect(scenario.gateway.control.catalogReads).toEqual(Array(5).fill("gmail"));
    expect(scenario.gateway.executions).toEqual([]);
    expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
      accounts: [],
      cursor: null,
      hasNextPage: false,
    });
  });

  test.each([
    { failure: "flat", code: "provider_not_configured" },
    { failure: "envelope", code: "rate_limited" },
    { failure: "text", code: "provider_error" },
    { failure: "malformed", code: "invalid_response" },
    { failure: "duplicate", code: "invalid_response" },
    { failure: "not-found", code: "not_found" },
    { failure: "invalid-json", code: "invalid_response" },
    { failure: "redirect", code: "unexpected_redirect" },
    { failure: "network", code: "client_network_error" },
  ] as const)(
    "$failure discovery failures are safe and never create accounts or follow redirects",
    async ({ failure, code }) => {
      const scenario = await connectorScenario();
      scenario.gateway.control.discoveryFailure = failure;
      for (const route of ["/provider-configs", "/provider-configs/gmail-provider/actions"]) {
        const readsBefore = scenario.gateway.control.discoveryReads;
        const result = await scenario.call("alice", "GET", route);
        expect(result).toMatchObject({
          status: 502,
          data: { code: "PROJECT_CONNECTOR_ERROR", message: expect.stringContaining(code) },
        });
        expect(JSON.stringify(result.data)).not.toContain("test-project-key");
        assert(scenario.gateway.control.discoveryReads === readsBefore + 1);
      }
      assert(scenario.gateway.control.redirectReads === 0);
      assert(scenario.gateway.requests.size === 0);
      expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
        accounts: [],
        cursor: null,
        hasNextPage: false,
      });
    },
  );

  test("Gmail authorization binds only a verified account, updates the client store, and selects it for actions", async () => {
    const scenario = await connectorScenario();
    const client = createProjectConnectorFragmentClient({
      baseUrl: "http://localhost",
      fetcherConfig: {
        type: "function",
        useOnServer: true,
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("x-test-user", "alice");
          const response = await scenario.fragment.handler(request);
          assert(response);
          return response;
        },
      },
    });
    const accountStore = client.useAccounts();
    const unsubscribe = accountStore.subscribe(() => undefined);
    try {
      await expect
        .poll(() => accountStore.get().data)
        .toEqual({ accounts: [], cursor: null, hasNextPage: false });
      const started = await client
        .connect()
        .mutate({ body: { service: "gmail", connectionName: "work", returnUri } });
      assert(started);
      expect((await scenario.storedRequest(started.id)).state).toEqual({ status: "initiated" });
      const pending = await scenario.call(
        "alice",
        "POST",
        `/connection-requests/${started.id}/refresh`,
      );
      expect(projectConnectorConnectionSchema.parse(pending.data).state).toEqual({
        status: "initiated",
      });
      scenario.gateway.authorize(started.id, "gmail-account");
      const refreshed = await client
        .refreshConnection()
        .mutate({ path: { requestId: started.id } });
      expect(refreshed?.state).toEqual({
        status: "connected",
        connectedAccountId: "gmail-account",
      });
      await expect
        .poll(() => accountStore.get().data?.accounts)
        .toEqual([
          {
            id: "gmail-account",
            projectId: "project-1",
            providerConfigId: "gmail-provider",
            externalUserId: "alice",
            service: "gmail",
            connectionName: "work",
          },
        ]);
      const profile = await scenario.call("alice", "GET", "/accounts/gmail-account/profile");
      assert(profile.status === 200);
      expect(profile.data).toMatchObject({
        connectedAccountId: "gmail-account",
        externalUserId: "alice",
        profile: { email: "gmail-user@example.test" },
      });
      const execution = await scenario.call(
        "alice",
        "POST",
        "/accounts/gmail-account/actions/gmail.search_threads",
        { input: { query: "is:unread" } },
      );
      expect(execution).toEqual({
        status: 200,
        data: {
          executionId: "execution-1",
          actionId: "gmail.search_threads",
          output: { threads: [], query: "is:unread" },
        },
      });
      expect(scenario.gateway.executions).toEqual([
        {
          externalUserId: "alice",
          providerConfigId: "gmail-provider",
          connectedAccountId: "gmail-account",
          input: { query: "is:unread" },
        },
      ]);
      expect((await scenario.storedRequest(started.id)).state).toEqual({
        status: "connected",
        connectedAccountId: "gmail-account",
      });
      const reads = scenario.gateway.control.requestReads;
      await scenario.call("alice", "POST", `/connection-requests/${started.id}/refresh`);
      expect(scenario.gateway.control.requestReads).toBe(reads);
    } finally {
      unsubscribe();
    }
  });

  test("unauthenticated or other users cannot create, refresh, inspect, or act on bindings", async () => {
    const scenario = await connectorScenario();
    const started = await scenario.connect("alice");
    scenario.gateway.authorize(started.id, "alice-account");
    assert(
      (await scenario.call("bob", "POST", `/connection-requests/${started.id}/refresh`)).status ===
        404,
    );
    assert(
      (
        await scenario.call(null, "POST", "/connection-requests", {
          service: "gmail",
          connectionName: "work",
          returnUri,
        })
      ).status === 401,
    );
    await scenario.call("alice", "POST", `/connection-requests/${started.id}/refresh`);
    assert((await scenario.call("bob", "GET", "/accounts/alice-account/profile")).status === 404);
    assert(
      (
        await scenario.call("bob", "POST", "/accounts/alice-account/actions/gmail.send_email", {
          input: {},
        })
      ).status === 404,
    );
    assert(
      (
        await scenario.call("alice", "POST", "/accounts/alice-account/actions/slack.post_message", {
          input: {},
        })
      ).status === 400,
    );
    expect((await scenario.call("bob", "GET", "/accounts")).data).toEqual({
      accounts: [],
      cursor: null,
      hasNextPage: false,
    });
    expect(scenario.gateway.executions).toEqual([]);
  });

  test.each([
    { identity: "projectId", wireField: "projectId" },
    { identity: "providerConfigId", wireField: "providerConfigId" },
    { identity: "externalUserId", wireField: "externalUserId" },
    { identity: "service", wireField: "service" },
    { identity: "id", wireField: "id" },
    { identity: "connectionName", wireField: "alias" },
  ] as const)("a mismatched $identity cannot create an account binding", async ({ wireField }) => {
    const scenario = await connectorScenario();
    const started = await scenario.connect("alice");
    scenario.gateway.authorize(started.id, "injected-account");
    const remote = scenario.gateway.requests.get(started.id);
    assert(remote);
    remote[wireField] = "wrong-identity";
    const result = await scenario.call(
      "alice",
      "POST",
      `/connection-requests/${started.id}/refresh`,
    );
    assert(result.status === 502);
    expect(result.data).toMatchObject({
      code: "PROJECT_CONNECTOR_ERROR",
      message: expect.stringContaining("connection_identity_mismatch"),
    });
    expect((await scenario.storedRequest(started.id)).state).toEqual({ status: "initiated" });
    expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
      accounts: [],
      cursor: null,
      hasNextPage: false,
    });
  });

  test.each(["expired", "failed"] as const)(
    "%s authorization remains terminal and never binds an account",
    async (status) => {
      const scenario = await connectorScenario();
      const started = await scenario.connect("alice");
      const remote = scenario.gateway.requests.get(started.id);
      assert(remote);
      remote.status = status;
      remote.errorCode = "access_denied";
      remote.errorMessage = "Consent denied";
      const first = await scenario.call(
        "alice",
        "POST",
        `/connection-requests/${started.id}/refresh`,
      );
      expect(projectConnectorConnectionSchema.parse(first.data).state.status).toBe(status);
      scenario.gateway.authorize(started.id, "too-late-account");
      const second = await scenario.call(
        "alice",
        "POST",
        `/connection-requests/${started.id}/refresh`,
      );
      expect(projectConnectorConnectionSchema.parse(second.data).state.status).toBe(status);
      expect((await scenario.storedRequest(started.id)).state.status).toBe(status);
      expect((await scenario.call("alice", "GET", "/accounts")).data).toEqual({
        accounts: [],
        cursor: null,
        hasNextPage: false,
      });
    },
  );

  test("OAuth links reject unapproved destinations, gateway-invalid connection names, and ambiguous or browser-controlled user selectors", async () => {
    const scenario = await connectorScenario();
    assert(
      (
        await scenario.call("alice", "POST", "/connection-requests", {
          service: "gmail",
          connectionName: "work",
          returnUri: "https://attacker.test",
        })
      ).status === 400,
    );
    assert(
      (
        await scenario.call("alice", "POST", "/connection-requests", {
          service: "gmail",
          providerConfigId: "gmail-provider",
          connectionName: "work",
          returnUri,
        })
      ).status === 400,
    );
    assert(
      (
        await scenario.call("alice", "POST", "/connection-requests", {
          service: "gmail",
          externalUserId: "bob",
          connectionName: "work",
          returnUri,
        })
      ).status === 400,
    );
    assert(
      (
        await scenario.call("alice", "POST", "/connection-requests", {
          service: "gmail",
          connectionName: "work",
          returnUri: "file:///tmp/foo",
        })
      ).status === 400,
    );
    for (const connectionName of ["Gmail", "_work", "-work", "my work"]) {
      assert(
        (
          await scenario.call("alice", "POST", "/connection-requests", {
            service: "gmail",
            connectionName,
            returnUri,
          })
        ).status === 400,
      );
    }
    assert(scenario.gateway.requests.size === 0);
  });

  test("account list uses bounded cursor pagination and never crosses user boundaries", async () => {
    const scenario = await connectorScenario();
    for (let index = 0; index < 26; index++) {
      await scenario.bind(
        "alice",
        `account-${index.toString().padStart(2, "0")}`,
        `gmail-${index}`,
      );
    }
    await scenario.bind("bob", "bob-account");
    const first = await scenario.call("alice", "GET", "/accounts");
    const page = first.data as { accounts: { id: string }[]; cursor: string; hasNextPage: boolean };
    expect(page.accounts).toHaveLength(25);
    assert(page.hasNextPage);
    const second = await scenario.call(
      "alice",
      "GET",
      `/accounts?cursor=${encodeURIComponent(page.cursor)}`,
    );
    const last = second.data as { accounts: { id: string }[]; hasNextPage: boolean };
    expect(last.accounts).toHaveLength(1);
    assert(!last.hasNextPage);
    assert(new Set([...page.accounts, ...last.accounts].map((account) => account.id)).size === 26);
    assert((await scenario.call("alice", "GET", "/accounts?cursor=not-a-cursor")).status === 400);
    assert(
      (await scenario.call("bob", "GET", `/accounts?cursor=${encodeURIComponent(page.cursor)}`))
        .status === 400,
    );
  });

  test.each([undefined, null, 42, true, {}, [], ""].map((id) => ({ id })))(
    "account cursors with invalid ID $id return INVALID_CURSOR without disturbing bindings",
    async ({ id }) => {
      const scenario = await connectorScenario();
      await scenario.bind("alice", "gmail-account");
      const cursor = Buffer.from(
        JSON.stringify({
          v: 1,
          indexName: "idx_account_external_user_id",
          orderDirection: "asc",
          pageSize: 25,
          indexValues: { externalUserId: "alice", id },
        }),
      ).toString("base64");
      const result = await scenario.call(
        "alice",
        "GET",
        `/accounts?cursor=${encodeURIComponent(cursor)}`,
      );
      assert(result.status === 400);
      expect(result.data).toMatchObject({ code: "INVALID_CURSOR" });
      expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({
        accounts: [{ id: "gmail-account" }],
      });
    },
  );

  test.each(["flat", "envelope", "text", "malformed"] as const)(
    "%s upstream failures are safe, are not retried, and preserve account bindings",
    async (failure) => {
      const scenario = await connectorScenario();
      await scenario.bind("alice", "gmail-account");
      scenario.gateway.control.actionFailure = failure;
      const result = await scenario.call(
        "alice",
        "POST",
        "/accounts/gmail-account/actions/gmail.search_threads",
        { input: {} },
      );
      assert(result.status === 502);
      expect(JSON.stringify(result.data)).not.toContain("test-project-key");
      expect(scenario.gateway.executions).toHaveLength(1);
      expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({
        accounts: [{ id: "gmail-account" }],
      });
    },
  );

  test("profile verification rejects a mismatched product user", async () => {
    const scenario = await connectorScenario();
    await scenario.bind("alice", "gmail-account");
    scenario.gateway.control.profileUserId = "bob";
    assert((await scenario.call("alice", "GET", "/accounts/gmail-account/profile")).status === 502);
  });

  test("migration preserves duplicate names and ID-based operations", async () => {
    const scenario = await connectorScenario("test-catalog-key", 2);
    // Existing starts do not acquire a new dependency on provider discovery.
    scenario.gateway.control.discoveryFailure = "not-found";
    const first = await scenario.bind("alice", "legacy-work-1");
    const second = await scenario.bind("alice", "legacy-work-2");
    const adapter = scenario.setup.test.adapter;
    assert(adapter.prepareMigrations);
    const { schema, namespace } = scenario.setup.fragments.connector.fragment.$internal.deps;
    // The test adapter intentionally does not persist migration versions.
    await adapter.prepareMigrations(schema, namespace).execute(2, schema.version, {
      updateVersionInMigration: false,
    });
    await scenario.setup.test.recreateFragments();
    const query = new URLSearchParams({
      projectId: "project-1",
      providerConfigId: "gmail-provider",
      connectionName: "work",
    }).toString();
    for (const route of ["/connection-requests/by-name", "/accounts/by-name"]) {
      expect(await scenario.call("alice", "GET", `${route}?${query}`)).toMatchObject({
        status: 409,
        data: { code: "CONNECTION_AMBIGUOUS" },
      });
      expect(await scenario.call("bob", "GET", `${route}?${query}`)).toEqual({
        status: 200,
        data: route === "/connection-requests/by-name" ? { request: null } : { account: null },
      });
    }
    const accounts = await scenario.call("alice", "GET", "/accounts");
    expect(accounts).toMatchObject({
      status: 200,
      data: {
        accounts: expect.arrayContaining([
          {
            id: "legacy-work-1",
            projectId: first.projectId,
            providerConfigId: first.providerConfigId,
            externalUserId: "alice",
            service: "gmail",
            connectionName: "work",
          },
          {
            id: "legacy-work-2",
            projectId: second.projectId,
            providerConfigId: second.providerConfigId,
            externalUserId: "alice",
            service: "gmail",
            connectionName: "work",
          },
        ]),
        hasNextPage: false,
      },
    });
    for (const request of [first, second]) {
      const refreshed = await scenario.call(
        "alice",
        "POST",
        `/connection-requests/${request.id}/refresh`,
      );
      expect(refreshed).toMatchObject({
        status: 200,
        data: {
          id: request.id,
          connectionName: "work",
          state: { status: "connected" },
        },
      });
    }
    expect(await scenario.call("alice", "GET", "/accounts/legacy-work-1/profile")).toMatchObject({
      status: 200,
      data: { connectedAccountId: "legacy-work-1" },
    });
    expect(
      await scenario.call("alice", "POST", "/accounts/legacy-work-1/actions/gmail.search_threads", {
        input: { query: "is:unread" },
      }),
    ).toMatchObject({ status: 200, data: { actionId: "gmail.search_threads" } });
    assert(scenario.gateway.control.discoveryReads === 0);
    expect(scenario.gateway.links).toHaveLength(2);
  });

  test("named setup reconstructs pending OAuth after recreation and updates named client stores", async () => {
    const scenario = await connectorScenario();
    const selector = {
      projectId: "project-1",
      providerConfigId: "gmail-provider",
      connectionName: "work-mailbox",
    };
    const query = new URLSearchParams(selector).toString();
    const client = createProjectConnectorFragmentClient({
      baseUrl: "http://localhost",
      fetcherConfig: {
        type: "function",
        useOnServer: true,
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("x-test-user", "alice");
          const response = await scenario.setup.fragments.connector.fragment.handler(request);
          assert(response);
          return response;
        },
      },
    });
    const requestStore = client.useNamedConnectionRequest({ query: selector });
    const accountStore = client.useNamedAccount({ query: selector });
    const unsubscribeRequest = requestStore.subscribe(() => undefined);
    const unsubscribeAccount = accountStore.subscribe(() => undefined);
    try {
      await expect.poll(() => requestStore.get().data).toEqual({ request: null });
      await expect.poll(() => accountStore.get().data).toEqual({ account: null });
      const started = await client.connect().mutate({
        body: {
          providerConfigId: selector.providerConfigId,
          connectionName: selector.connectionName,
          returnUri,
        },
      });
      assert(started);
      await expect.poll(() => requestStore.get().data).toEqual({ request: started });
      expect(scenario.gateway.links).toHaveLength(1);
      await scenario.setup.test.recreateFragments();
      const recovered = await scenario.call(
        "alice",
        "GET",
        `/connection-requests/by-name?${query}`,
      );
      expect(recovered).toEqual({ status: 200, data: { request: started } });
      assert(scenario.gateway.control.requestReads === 0);
      expect(await scenario.call("alice", "GET", `/accounts/by-name?${query}`)).toEqual({
        status: 200,
        data: { account: null },
      });
      scenario.gateway.authorize(started.id, "work-account");
      const { request } = projectConnectorNamedRequestSchema.parse(recovered.data);
      assert(request);
      const confirmed = await client
        .refreshConnection()
        .mutate({ path: { requestId: request.id } });
      expect(confirmed?.state).toEqual({ status: "connected", connectedAccountId: "work-account" });
      await expect.poll(() => requestStore.get().data?.request?.state).toEqual(confirmed?.state);
      await expect
        .poll(() => accountStore.get().data)
        .toEqual({
          account: {
            id: "work-account",
            ...selector,
            externalUserId: "alice",
            service: "gmail",
          },
        });
      const next = await client.connect().mutate({
        body: {
          providerConfigId: selector.providerConfigId,
          connectionName: selector.connectionName,
          returnUri,
        },
      });
      assert(next);
      expect(next.id).not.toBe(started.id);
      await expect.poll(() => requestStore.get().error?.code).toBe("CONNECTION_AMBIGUOUS");
      scenario.gateway.authorize(next.id, "second-work-account");
      await client.refreshConnection().mutate({ path: { requestId: next.id } });
      await expect.poll(() => accountStore.get().error?.code).toBe("CONNECTION_AMBIGUOUS");
      expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({
        accounts: [{ id: "second-work-account" }, { id: "work-account" }],
      });
      expect(scenario.gateway.executions).toEqual([]);
    } finally {
      unsubscribeRequest();
      unsubscribeAccount();
    }
  });

  test("named selectors isolate owners, projects, providers, and connection names", async () => {
    const scenario = await connectorScenario();
    const [provider] = scenario.gateway.providerConfigs;
    assert(provider);
    scenario.gateway.providerConfigs.push({ ...provider, id: "gmail-personal" });
    const selector = {
      projectId: "project-1",
      providerConfigId: provider.id,
      connectionName: "work-mail",
    };
    const original = await scenario.call("alice", "POST", "/connection-requests", {
      providerConfigId: selector.providerConfigId,
      connectionName: selector.connectionName,
      returnUri,
    });
    const started = projectConnectorConnectionSchema.parse(original.data);
    const personal = await scenario.call("alice", "POST", "/connection-requests", {
      providerConfigId: "gmail-personal",
      connectionName: selector.connectionName,
      returnUri,
    });
    const other = projectConnectorConnectionSchema.parse(personal.data);
    expect(other.id).not.toBe(started.id);
    for (const [name, id] of [
      [provider.id, started.id],
      ["gmail-personal", other.id],
    ]) {
      const query = new URLSearchParams({ ...selector, providerConfigId: name }).toString();
      expect(
        await scenario.call("alice", "GET", `/connection-requests/by-name?${query}`),
      ).toMatchObject({
        status: 200,
        data: { request: { id } },
      });
    }
    scenario.gateway.authorize(started.id, "work-account");
    await scenario.call("alice", "POST", `/connection-requests/${started.id}/refresh`);
    for (const selected of [
      { ...selector, projectId: "other-project" },
      { ...selector, providerConfigId: "other-provider" },
      { ...selector, connectionName: "work_mail" },
      { ...selector, connectionName: "work-mai" },
    ]) {
      const query = new URLSearchParams(selected).toString();
      for (const route of ["/connection-requests/by-name", "/accounts/by-name"]) {
        expect(await scenario.call("alice", "GET", `${route}?${query}`)).toEqual({
          status: 200,
          data: route === "/connection-requests/by-name" ? { request: null } : { account: null },
        });
      }
    }
    const query = new URLSearchParams(selector).toString();
    for (const route of ["/connection-requests/by-name", "/accounts/by-name"]) {
      expect(await scenario.call("bob", "GET", `${route}?${query}`)).toEqual({
        status: 200,
        data: route === "/connection-requests/by-name" ? { request: null } : { account: null },
      });
      expect(await scenario.call(null, "GET", `${route}?${query}`)).toMatchObject({
        status: 401,
        data: { code: "UNAUTHENTICATED" },
      });
      expect(await scenario.call("alice", "GET", `${route}?projectId=project-1`)).toMatchObject({
        status: 400,
        data: { code: "INVALID_SELECTOR" },
      });
      expect(
        await scenario.call(
          "alice",
          "GET",
          `${route}?${new URLSearchParams({ ...selector, connectionName: "" })}`,
        ),
      ).toMatchObject({ status: 400, data: { code: "INVALID_SELECTOR" } });
    }
    expect(scenario.gateway.executions).toEqual([]);
  });

  test("fresh starts preserve pending and terminal request IDs instead of choosing a current attempt", async () => {
    const scenario = await connectorScenario();
    const query = new URLSearchParams({
      projectId: "project-1",
      providerConfigId: "gmail-provider",
      connectionName: "work",
    }).toString();
    const terminal = [];
    for (const status of ["failed", "expired"] as const) {
      const started = await scenario.connect("alice");
      const remote = scenario.gateway.requests.get(started.id);
      assert(remote);
      remote.status = status;
      remote.errorCode = status === "failed" ? "authorization_failed" : null;
      remote.errorMessage = status === "failed" ? "Consent was rejected" : null;
      expect(
        await scenario.call("alice", "POST", `/connection-requests/${started.id}/refresh`),
      ).toMatchObject({ status: 200, data: { state: { status } } });
      terminal.push({ id: started.id, status });
    }
    const pending = await scenario.connect("alice");
    const next = await scenario.connect("alice");
    expect(next.id).not.toBe(pending.id);
    expect(
      await scenario.call("alice", "GET", `/connection-requests/by-name?${query}`),
    ).toMatchObject({ status: 409, data: { code: "CONNECTION_AMBIGUOUS" } });
    await scenario.setup.test.recreateFragments();
    for (const request of [
      ...terminal,
      { id: pending.id, status: "initiated" },
      { id: next.id, status: "initiated" },
    ]) {
      expect(
        await scenario.call("alice", "POST", `/connection-requests/${request.id}/refresh`),
      ).toMatchObject({ status: 200, data: { id: request.id, state: { status: request.status } } });
    }
    expect(await scenario.call("alice", "GET", `/accounts/by-name?${query}`)).toEqual({
      status: 200,
      data: { account: null },
    });
    const [requests] = await scenario.db
      .createUnitOfWork("preserved-oauth-attempts")
      .forSchema(projectConnectorSchema)
      .find("connectionRequest", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(requests).toHaveLength(4);
    expect(scenario.gateway.links).toHaveLength(4);
  });

  test("concurrent starts retain distinct attempts and same-name accounts remain usable by ID", async () => {
    const scenario = await connectorScenario();
    const [first, second] = await Promise.all([
      scenario.connect("alice"),
      scenario.connect("alice"),
    ]);
    expect(second.id).not.toBe(first.id);
    const query = new URLSearchParams({
      projectId: first.projectId,
      providerConfigId: first.providerConfigId,
      connectionName: "work",
    }).toString();
    const reads = scenario.gateway.control.requestReads;
    expect(
      await scenario.call("alice", "GET", `/connection-requests/by-name?${query}`),
    ).toMatchObject({ status: 409, data: { code: "CONNECTION_AMBIGUOUS" } });
    expect(scenario.gateway.control.requestReads).toBe(reads);
    scenario.gateway.authorize(first.id, "first-account");
    scenario.gateway.authorize(second.id, "second-account");
    for (const request of [first, second]) {
      expect(
        await scenario.call("alice", "POST", `/connection-requests/${request.id}/refresh`),
      ).toMatchObject({ status: 200, data: { state: { status: "connected" } } });
    }
    const accounts = await scenario.call("alice", "GET", "/accounts");
    expect(accounts.data).toMatchObject({
      accounts: [{ id: "first-account" }, { id: "second-account" }],
    });
    expect(await scenario.call("alice", "GET", `/accounts/by-name?${query}`)).toMatchObject({
      status: 409,
      data: { code: "CONNECTION_AMBIGUOUS" },
    });
    for (const accountId of ["first-account", "second-account"]) {
      expect(await scenario.call("alice", "GET", `/accounts/${accountId}/profile`)).toMatchObject({
        status: 200,
        data: { connectedAccountId: accountId },
      });
      expect(
        await scenario.call(
          "alice",
          "POST",
          `/accounts/${accountId}/actions/gmail.search_threads`,
          { input: {} },
        ),
      ).toMatchObject({ status: 200, data: { actionId: "gmail.search_threads" } });
    }
    expect(scenario.gateway.executions.map((execution) => execution.connectedAccountId)).toEqual([
      "first-account",
      "second-account",
    ]);
    expect(scenario.gateway.links).toHaveLength(2);
    const [saved] = await scenario.db
      .createUnitOfWork("concurrent-oauth-attempts")
      .forSchema(projectConnectorSchema)
      .find("connectionRequest", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(saved).toHaveLength(2);
  });

  test("a conflicting incoming account ID cannot steal another user's named binding", async () => {
    const scenario = await connectorScenario();
    await scenario.bind("bob", "bob-account");
    const started = await scenario.connect("alice");
    scenario.gateway.authorize(started.id, "bob-account");
    expect(
      await scenario.call("alice", "POST", `/connection-requests/${started.id}/refresh`),
    ).toMatchObject({ status: 500, data: { code: "INTERNAL_SERVER_ERROR" } });
    expect((await scenario.call("bob", "GET", "/accounts")).data).toMatchObject({
      accounts: [{ id: "bob-account", externalUserId: "bob" }],
    });
    expect((await scenario.call("alice", "GET", "/accounts")).data).toMatchObject({ accounts: [] });
    expect((await scenario.storedRequest(started.id)).state).toEqual({ status: "initiated" });
  });

  test("reauthorization updates one binding without duplicating the connected account", async () => {
    const scenario = await connectorScenario();
    await scenario.bind("alice", "gmail-account");
    await scenario.bind("alice", "gmail-account");
    const accounts = await scenario.call("alice", "GET", "/accounts");
    expect(accounts.data).toMatchObject({
      accounts: [{ id: "gmail-account", externalUserId: "alice" }],
      hasNextPage: false,
    });
    assert(scenario.gateway.requests.size === 2);
    const records = await scenario.db
      .createUnitOfWork("verify-reauthorization")
      .forSchema(projectConnectorSchema)
      .find("connectedAccount", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(records[0]).toHaveLength(1);
    // The second attempt starts and completes while the name already has a confirmed account.
    const connection = {
      projectId: "project-1",
      providerConfigId: "gmail-provider",
      connectionName: "work",
    };
    expect(await scenario.readinessChanges()).toEqual([
      { externalUserId: "alice", service: "gmail", connection, ready: false },
      { externalUserId: "alice", service: "gmail", connection, ready: true },
    ]);
  });

  test("authenticated project-key status check does not create a connection request", async () => {
    const scenario = await connectorScenario();
    expect(await scenario.call("alice", "GET", "/status")).toEqual({
      status: 200,
      data: { authenticated: true },
    });
    assert((await scenario.call(null, "GET", "/status")).status === 401);
    assert(scenario.gateway.requests.size === 0);
  });
});
