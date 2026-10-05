import { afterEach, assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createProjectConnectorFragmentClient } from "./client/vanilla";
import { projectConnectorFragmentDefinition } from "./definition";
import { projectConnectorConnectionSchema } from "./project-connector-contracts";
import { projectConnectorRoutes } from "./routes";
import { projectConnectorSchema } from "./schema";
import { startProjectConnectorTestGateway } from "./testing/project-connector-test-gateway";

const cleanup: (() => Promise<void>)[] = [];
const returnUri = "http://localhost/connected";

async function connectorScenario() {
  const gateway = await startProjectConnectorTestGateway();
  cleanup.push(gateway.close);
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "connector",
      instantiate(projectConnectorFragmentDefinition)
        .withConfig({
          baseUrl: gateway.baseUrl,
          apiKey: "test-project-key",
          getExternalUserId: (headers) => headers.get("x-test-user"),
          allowedReturnUrls: (url) => url.toString() === returnUri,
        })
        .withRoutes([projectConnectorRoutes]),
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
    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}${route}`, {
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
  return { gateway, setup, fragment, db, call, connect, bind, storedRequest };
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
        data: { projectId: "project-1", providerConfigId: selectedConfig.id, actionIds },
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
          actionIds: ["gmail.send_email"],
        });
      expect(JSON.stringify(actionsStore.get().data)).not.toContain("test-project-key");
      personalConfig.actionIds.splice(0);
      expect(
        await scenario.call("alice", "GET", "/provider-configs/gmail-personal/actions"),
      ).toEqual({
        status: 200,
        data: { projectId: "project-1", providerConfigId: "gmail-personal", actionIds: [] },
      });
      expect(
        await scenario.call("alice", "GET", "/provider-configs/unknown/actions"),
      ).toMatchObject({
        status: 404,
        data: { code: "PROVIDER_CONFIG_NOT_FOUND" },
      });
      assert(scenario.gateway.requests.size === 0);
      expect(scenario.gateway.executions).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test.each([
    { failure: "flat", code: "provider_not_configured" },
    { failure: "envelope", code: "rate_limited" },
    { failure: "text", code: "provider_error" },
    { failure: "malformed", code: "invalid_response" },
    { failure: "duplicate", code: "invalid_response" },
    { failure: "not-found", code: "not_found" },
    { failure: "invalid-json", code: "invalid_response" },
    { failure: "redirect", code: "client_network_error" },
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

  test("OAuth links reject unapproved destinations and ambiguous or browser-controlled user selectors", async () => {
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
