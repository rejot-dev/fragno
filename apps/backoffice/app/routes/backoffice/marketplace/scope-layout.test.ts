import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock, lookupAutomationProjectMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  lookupAutomationProjectMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));
vi.mock("../automations/data.server", () => ({
  lookupAutomationProject: lookupAutomationProjectMock,
}));

import { loader } from "./scope-layout";

const requestUrl = "https://example.test/backoffice/marketplace/user/user-1/marketplace";

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  lookupAutomationProjectMock.mockReset();
});

describe("personal Marketplace scope", () => {
  test("loads without an organization or Automations project database", async () => {
    findBackofficeMeMock.mockResolvedValue({
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
    expect(lookupAutomationProjectMock).not.toHaveBeenCalled();
  });
});

describe("organisation Marketplace scope", () => {
  test("resolves the organisation without fetching Automations projects", async () => {
    const orgUrl = new URL("https://example.test/backoffice/marketplace/org/org-1/marketplace");
    findBackofficeMeMock.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [{ organization: { id: "org-1", name: "Ada Labs" } }],
      activeOrganization: { organization: { id: "org-1", name: "Ada Labs" } },
    });

    const result = await loader({
      request: new Request(orgUrl),
      params: { scopeKind: "org", scopeId: "org-1" },
      context: {},
      url: orgUrl,
    } as never);

    assert(!(result instanceof Response));
    expect(result.selectedScope).toEqual({ kind: "org", orgId: "org-1", label: "Ada Labs" });
    expect(lookupAutomationProjectMock).not.toHaveBeenCalled();
  });
});
