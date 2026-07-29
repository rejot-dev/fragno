import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { fetchAutomationAdapterIdentityMock, fetchAutomationProjectsMock, getAuthMeMock } =
  vi.hoisted(() => ({
    fetchAutomationAdapterIdentityMock: vi.fn(),
    fetchAutomationProjectsMock: vi.fn(),
    getAuthMeMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/auth-server", () => ({ getAuthMe: getAuthMeMock }));
vi.mock("../automations/data.server", () => ({
  fetchAutomationAdapterIdentity: fetchAutomationAdapterIdentityMock,
  fetchAutomationProjects: fetchAutomationProjectsMock,
}));

import { loader } from "./scope-layout";

const requestUrl = "https://example.test/backoffice/marketplace/user/user-1/marketplace";

beforeEach(() => {
  fetchAutomationAdapterIdentityMock.mockReset();
  fetchAutomationProjectsMock.mockReset();
  getAuthMeMock.mockReset();
});

describe("personal Marketplace scope", () => {
  test("loads without an organization or Automations project database", async () => {
    getAuthMeMock.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [],
      activeOrganization: null,
    });

    const result = await loader({
      request: new Request(requestUrl),
      params: { scopeKind: "user", scopeId: "user-1" },
      context: {},
      url: new URL(requestUrl),
    } as never);

    assert(!(result instanceof Response));
    expect(result.selectedScope).toEqual({
      kind: "user",
      userId: "user-1",
      label: "ada@example.com",
    });
    expect(result.ingestionCollectionSources).toEqual([]);
    expect(result.scopeOptions).toEqual([
      {
        id: "user:user-1",
        kind: "user",
        label: "ada@example.com",
        description: "Personal workspace",
        to: "/backoffice/marketplace/user/user-1/marketplace",
      },
    ]);
    expect(fetchAutomationProjectsMock).not.toHaveBeenCalled();
    expect(fetchAutomationAdapterIdentityMock).not.toHaveBeenCalled();
  });

  test("keeps the current listing and query when switching scopes", async () => {
    const listingRef = "c3lzdGVtI3RlbGVncmFtLXRlc3QtY29tbWFuZA";
    const detailUrl = new URL(
      `https://example.test/backoffice/marketplace/user/user-1/marketplace/${listingRef}?versionCursor=next-page`,
    );
    getAuthMeMock.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [{ organization: { id: "org-1", name: "Ada Labs" } }],
      activeOrganization: { organization: { id: "org-1", name: "Ada Labs" } },
    });
    fetchAutomationProjectsMock.mockResolvedValue({ projects: [], projectsError: null });
    fetchAutomationAdapterIdentityMock.mockResolvedValue(null);

    const result = await loader({
      request: new Request(detailUrl),
      params: { scopeKind: "user", scopeId: "user-1", listingRef },
      context: {},
      url: detailUrl,
    } as never);

    assert(!(result instanceof Response));
    expect(result.scopeOptions).toContainEqual({
      id: "org:org-1",
      kind: "org",
      label: "Ada Labs",
      description: "Organisation workspace",
      to: `/backoffice/marketplace/org/org-1/marketplace/${listingRef}?versionCursor=next-page`,
    });
  });
});
