import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { describeAutomationCollectionSource } from "./browser-database";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Automation collection sources", () => {
  test("describes the organization-scoped Automations Durable Object", () => {
    const description = describeAutomationCollectionSource({
      resolvedScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      adapterIdentity: "adapter-1",
    });

    assert.equal(description.baseUrl, "/api/automations-scoped/org/org-1");
    assert.equal(description.internalUrl, "/api/automations-scoped/org/org-1/_internal");
    assert.equal(description.resourceKey, JSON.stringify(["org:org-1", "adapter-1"]));
  });

  test("uses the encoded route id for project-scoped outboxes", () => {
    const description = describeAutomationCollectionSource({
      resolvedScope: {
        kind: "project",
        organization: { id: "org-1", slug: "acme" },
        projectId: "project/one",
      },
      adapterIdentity: "adapter-1",
    });

    assert.equal(
      description.internalUrl,
      "/api/automations-scoped/project/org-1%3Aproject%252Fone/_internal",
    );
  });

  test("isolates persisted data when the adapter identity changes", () => {
    const resolvedScope = {
      kind: "org",
      organization: { id: "org-1", slug: "acme" },
    } as const;
    const first = describeAutomationCollectionSource({
      resolvedScope,
      adapterIdentity: "adapter-1",
    });
    const second = describeAutomationCollectionSource({
      resolvedScope,
      adapterIdentity: "adapter-2",
    });

    assert.notEqual(first.resourceKey, second.resourceKey);
  });

  test("keeps a rejected Suspense resource cached", async () => {
    const fetchMock = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("location", new URL("http://localhost:5173/backoffice"));
    vi.stubGlobal("fetch", fetchMock);
    const { getAutomationBrowserDatabase } = await import("./browser-database");
    const source = {
      resolvedScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      adapterIdentity: "adapter-1",
    } as const;

    const first = getAutomationBrowserDatabase(source);
    await expect(first).rejects.toThrow(/503/);
    const second = getAutomationBrowserDatabase(source);

    assert.equal(second, first);
    assert.equal(fetchMock.mock.calls.length, 1);
  });
});
