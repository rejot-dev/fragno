import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createCloudflareApiClient } from "../cloudflare-api";
import { cloudflareFragmentDefinition, type CloudflareFragmentConfig } from "../definition";
import { createBrowserRunSessionClients } from "./session-clients";
import { browserRunSessionRoutesFactory } from "./session-routes";
import { createBrowserRunSessions } from "./sessions";

const fetchMock = vi.fn<typeof fetch>();
const cloudflare = createCloudflareApiClient({
  apiToken: "cf_test_token",
  fetchImplementation: fetchMock,
});
const config: CloudflareFragmentConfig = {
  accountId: "acct_test",
  cloudflare,
};

const createDevtoolsResponse = (result: unknown) =>
  new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const requestUrl = (callIndex: number) => String(fetchMock.mock.calls[callIndex]?.[0]);
const requestMethod = (callIndex: number) => fetchMock.mock.calls[callIndex]?.[1]?.method ?? "GET";

describe("Browser Run sessions", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test("maps session and target operations to the Cloudflare DevTools API", async () => {
    const sessions = createBrowserRunSessions(cloudflare, "acct_test");

    fetchMock
      .mockResolvedValueOnce(
        createDevtoolsResponse({
          sessionId: "session_1",
          webSocketDebuggerUrl: "wss://fragno.dev/session_1",
        }),
      )
      .mockResolvedValueOnce(createDevtoolsResponse([{ sessionId: "session_1", startTime: 1 }]))
      .mockResolvedValueOnce(createDevtoolsResponse({ sessionId: "session_1", startTime: 1 }))
      .mockResolvedValueOnce(createDevtoolsResponse({ status: "closing" }))
      .mockResolvedValueOnce(
        createDevtoolsResponse({
          id: "target_1",
          type: "page",
          url: "https://fragno.dev",
        }),
      )
      .mockResolvedValueOnce(
        createDevtoolsResponse([{ id: "target_1", type: "page", url: "https://fragno.dev" }]),
      )
      .mockResolvedValueOnce(
        createDevtoolsResponse({
          id: "target_1",
          type: "page",
          url: "https://fragno.dev",
        }),
      )
      .mockResolvedValueOnce(createDevtoolsResponse({ message: "Target activated" }))
      .mockResolvedValueOnce(createDevtoolsResponse({ message: "Target is closing" }));

    await expect(sessions.create({ keep_alive: 600_000 })).resolves.toMatchObject({
      sessionId: "session_1",
    });
    await expect(sessions.list({ limit: 10, offset: 2 })).resolves.toHaveLength(1);
    await expect(sessions.get("session_1")).resolves.toMatchObject({ sessionId: "session_1" });
    await expect(sessions.close("session_1")).resolves.toEqual({ status: "closing" });
    await expect(
      sessions.createTarget("session_1", { url: "https://fragno.dev" }),
    ).resolves.toMatchObject({ id: "target_1" });
    await expect(sessions.listTargets("session_1")).resolves.toHaveLength(1);
    await expect(sessions.getTarget("session_1", "target_1")).resolves.toMatchObject({
      id: "target_1",
    });
    await expect(sessions.activateTarget("session_1", "target_1")).resolves.toEqual({
      message: "Target activated",
    });
    await expect(sessions.closeTarget("session_1", "target_1")).resolves.toEqual({
      message: "Target is closing",
    });

    expect(requestUrl(0)).toContain(
      "/accounts/acct_test/browser-rendering/devtools/browser?keep_alive=600000",
    );
    assert(requestMethod(0) === "POST");
    expect(requestUrl(1)).toContain(
      "/accounts/acct_test/browser-rendering/devtools/session?limit=10&offset=2",
    );
    expect(requestUrl(2)).toContain(
      "/accounts/acct_test/browser-rendering/devtools/session/session_1",
    );
    assert(requestMethod(3) === "DELETE");
    expect(requestUrl(4)).toContain(
      "/accounts/acct_test/browser-rendering/devtools/browser/session_1/json/new?url=https%3A%2F%2Ffragno.dev",
    );
    assert(requestMethod(4) === "PUT");
    expect(requestUrl(5)).toContain(
      "/accounts/acct_test/browser-rendering/devtools/browser/session_1/json/list",
    );
    expect(requestUrl(7)).toContain("/json/activate/target_1");
    expect(requestUrl(8)).toContain("/json/close/target_1");
  });
});

describe("Browser Run session routes", () => {
  type TestSetup = Awaited<ReturnType<typeof buildSetup>>;

  let fragment!: TestSetup["fragments"]["cloudflare"]["fragment"];
  let testContext!: TestSetup["test"];

  async function buildSetup() {
    return await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "cloudflare",
        instantiate(cloudflareFragmentDefinition)
          .withConfig(config)
          .withRoutes([browserRunSessionRoutesFactory]),
      )
      .build();
  }

  beforeAll(async () => {
    const setup = await buildSetup();
    fragment = setup.fragments.cloudflare.fragment;
    testContext = setup.test;
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("creates, lists, reads, and closes sessions through typed routes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createDevtoolsResponse({
          sessionId: "session_1",
          webSocketDebuggerUrl: "wss://fragno.dev/session_1",
        }),
      )
      .mockResolvedValueOnce(createDevtoolsResponse([{ sessionId: "session_1" }]))
      .mockResolvedValueOnce(createDevtoolsResponse({ sessionId: "session_1" }))
      .mockResolvedValueOnce(createDevtoolsResponse({ status: "closing" }));

    const created = await fragment.callRoute("POST", "/browser-run/sessions", {
      body: { keep_alive: 600_000 },
    });
    const listed = await fragment.callRoute("GET", "/browser-run/sessions", {
      query: { limit: "10", offset: "0" },
    });
    const read = await fragment.callRoute("GET", "/browser-run/sessions/:sessionId", {
      pathParams: { sessionId: "session_1" },
    });
    const closed = await fragment.callRoute("DELETE", "/browser-run/sessions/:sessionId", {
      pathParams: { sessionId: "session_1" },
    });

    assert(created.type === "json");
    assert(listed.type === "json");
    assert(read.type === "json");
    assert(closed.type === "json");
    assert(created.data.sessionId === "session_1");
    expect(listed.data).toEqual([{ sessionId: "session_1" }]);
    assert(read.data.sessionId === "session_1");
    assert(closed.data.status === "closing");
  });

  test("returns a typed not-found error for a missing session", async () => {
    fetchMock.mockResolvedValueOnce(createDevtoolsResponse(null));

    const response = await fragment.callRoute("GET", "/browser-run/sessions/:sessionId", {
      pathParams: { sessionId: "missing" },
    });

    assert(response.type === "error");
    assert(response.status === 404);
    assert(response.error.code === "BROWSER_SESSION_NOT_FOUND");
  });

  test("rejects session list limits above Cloudflare's maximum", async () => {
    const response = await fragment.callRoute("GET", "/browser-run/sessions", {
      query: { limit: "201" },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_BROWSER_SESSION_QUERY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("exposes framework-neutral client helpers for every session route", () => {
    expect(Object.keys(createBrowserRunSessionClients())).toEqual([
      "useBrowserRunSessions",
      "useBrowserRunSession",
      "useCreateBrowserRunSession",
      "useCloseBrowserRunSession",
      "useBrowserRunTargets",
      "useBrowserRunTarget",
      "fetchBrowserRunTarget",
      "useCreateBrowserRunTarget",
      "useActivateBrowserRunTarget",
      "useCloseBrowserRunTarget",
    ]);
  });

  test("fetches fresh target metadata without using the hook cache", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      createDevtoolsResponse({
        id: "target_1",
        type: "page",
        url: "https://fragno.dev",
        devtoolsFrontendUrl: "https://devtools.example.test/target_1",
      }),
    );
    const clients = createBrowserRunSessionClients({
      mountRoute: "/api/cloudflare",
      fetcherConfig: { type: "function", fetcher, useOnServer: true },
    });

    await expect(clients.fetchBrowserRunTarget("session_1", "target_1")).resolves.toMatchObject({
      id: "target_1",
      devtoolsFrontendUrl: "https://devtools.example.test/target_1",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/cloudflare/browser-run/sessions/session_1/targets/target_1",
    );
  });
});
