import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { fetchPiManagerAvailableModelsMock, requireBackofficeContextMock, requireBackofficeMeMock } =
  vi.hoisted(() => ({
    fetchPiManagerAvailableModelsMock: vi.fn(),
    requireBackofficeContextMock: vi.fn(),
    requireBackofficeMeMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/auth-server", () => ({
  requireBackofficeMe: requireBackofficeMeMock,
}));
vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));
vi.mock("./data", () => ({
  fetchPiManagerAvailableModels: fetchPiManagerAvailableModelsMock,
}));
import { loader } from "./organization-layout";
import { isPiAgentsPath } from "./path";

beforeEach(() => {
  fetchPiManagerAvailableModelsMock.mockReset();
  fetchPiManagerAvailableModelsMock.mockResolvedValue([
    { provider: "faux", modelId: "faux-1", label: "Faux 1", contextWindow: 128_000 },
  ]);
  requireBackofficeContextMock.mockReset();
  requireBackofficeMeMock.mockReset();
});

describe("organization agents layout", () => {
  test("uses the active organization for system agent billing", async () => {
    const organization = {
      id: "org-123",
      slug: "wilcos-organization",
      name: "Wilco's organization",
    };
    requireBackofficeMeMock.mockResolvedValue({
      user: { id: "user-1" },
      organizations: [{ organization }],
      activeOrganization: { organization },
    });
    requireBackofficeContextMock.mockResolvedValue({ scope: { kind: "system" } });

    const result = await loader({
      request: new Request("http://localhost:5173/backoffice/agents/system/system/agents"),
      params: { scopeKind: "system", scopeId: "system" },
      context: {},
    } as never);

    expect(result.billingOrganization).toEqual(organization);
  });

  test("uses the route organization for billing without requiring an active organization", async () => {
    const organization = {
      id: "org-123",
      slug: "wilcos-organization",
      name: "Wilco's organization",
    };
    requireBackofficeMeMock.mockResolvedValue({
      user: { id: "user-1" },
      organizations: [{ organization }],
      activeOrganization: null,
    });
    requireBackofficeContextMock.mockResolvedValue({
      scope: { kind: "org", orgId: organization.id },
    });

    const result = await loader({
      request: new Request(
        "http://localhost:5173/backoffice/agents/org/wilcos-organization/agents",
      ),
      params: { scopeKind: "org", scopeId: organization.slug },
      context: {},
    } as never);

    expect(result.billingOrganization).toEqual(organization);
    expect(requireBackofficeContextMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      { kind: "org", orgId: organization.id },
    );
  });
});

describe("isPiAgentsPath", () => {
  const scope = { kind: "project" as const, orgSlug: "org-1", projectId: "project-1" };

  test.each([
    "/backoffice/agents/project/org-1%3Aproject-1/agents",
    "/backoffice/agents/project/org-1%3Aproject-1/agents/assistant",
    "/backoffice/agents/project/org-1%3Aproject-1/agents/assistant/debug",
    // React Router reports matched pathnames decoded, so the scope separator
    // arrives as a literal colon at runtime.
    "/backoffice/agents/project/org-1:project-1/agents",
    "/backoffice/agents/project/org-1:project-1/agents/assistant",
    "/backoffice/agents/project/org-1:project-1/agents/assistant/debug",
  ])("keeps the complete agents branch in the workspace layout: %s", (pathname) => {
    assert(isPiAgentsPath(scope, pathname));
  });

  test.each([
    "/backoffice/agents/project/org-1%3Aproject-1",
    "/backoffice/agents/project/org-1:project-1",
  ])("does not apply the workspace layout outside the agents branch: %s", (pathname) => {
    assert(!isPiAgentsPath(scope, pathname));
  });

  // Scope ids with reserved characters stay encoded inside the once-decoded
  // pathname; decoding again would corrupt them.
  const colonScope = { kind: "project" as const, orgSlug: "org-1", projectId: "a:b" };
  const slashScope = { kind: "project" as const, orgSlug: "org-1", projectId: "a/b" };

  test.each([
    [colonScope, "/backoffice/agents/project/org-1%3Aa%253Ab/agents/assistant"],
    [colonScope, "/backoffice/agents/project/org-1:a%3Ab/agents/assistant"],
    [slashScope, "/backoffice/agents/project/org-1%3Aa%252Fb/agents/assistant"],
    [slashScope, "/backoffice/agents/project/org-1:a%2Fb/agents/assistant"],
  ])("matches scope ids containing encoded characters: %o %s", (encodedScope, pathname) => {
    assert(isPiAgentsPath(encodedScope, pathname));
  });
});
