import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { fetchPiRuntimeStateMock, requireBackofficeContextMock, requireBackofficeMeMock } =
  vi.hoisted(() => ({
    fetchPiRuntimeStateMock: vi.fn(),
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
  fetchPiAdapterIdentity: vi.fn(),
  fetchPiRuntimeState: fetchPiRuntimeStateMock,
}));

import { loader } from "./organization-layout";
import { isPiSessionsPath } from "./path";

beforeEach(() => {
  fetchPiRuntimeStateMock.mockReset();
  requireBackofficeContextMock.mockReset();
  requireBackofficeMeMock.mockReset();

  fetchPiRuntimeStateMock.mockResolvedValue({
    runtimeState: { configured: false, modelCatalog: [] },
    runtimeError: null,
  });
});

describe("organization sessions layout", () => {
  test("uses the active organization for system session billing", async () => {
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
      request: new Request("http://localhost:5173/backoffice/sessions/system/system/sessions"),
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
        "http://localhost:5173/backoffice/sessions/org/wilcos-organization/sessions",
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

describe("isPiSessionsPath", () => {
  const scope = { kind: "project" as const, orgSlug: "org-1", projectId: "project-1" };

  test.each([
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1/debug",
    // React Router reports matched pathnames decoded, so the scope separator
    // arrives as a literal colon at runtime.
    "/backoffice/sessions/project/org-1:project-1/sessions",
    "/backoffice/sessions/project/org-1:project-1/sessions/pi/session-1",
    "/backoffice/sessions/project/org-1:project-1/sessions/pi/session-1/debug",
  ])("keeps the complete sessions branch in the workspace layout: %s", (pathname) => {
    assert(isPiSessionsPath(scope, pathname));
  });

  test.each([
    "/backoffice/sessions/project/org-1%3Aproject-1",
    "/backoffice/sessions/project/org-1:project-1",
  ])("does not apply the workspace layout outside the sessions branch: %s", (pathname) => {
    assert(!isPiSessionsPath(scope, pathname));
  });

  // Scope ids with reserved characters stay encoded inside the once-decoded
  // pathname; decoding again would corrupt them.
  const colonScope = { kind: "project" as const, orgSlug: "org-1", projectId: "a:b" };
  const slashScope = { kind: "project" as const, orgSlug: "org-1", projectId: "a/b" };

  test.each([
    [colonScope, "/backoffice/sessions/project/org-1%3Aa%253Ab/sessions/pi/session-1"],
    [colonScope, "/backoffice/sessions/project/org-1:a%3Ab/sessions/pi/session-1"],
    [slashScope, "/backoffice/sessions/project/org-1%3Aa%252Fb/sessions/pi/session-1"],
    [slashScope, "/backoffice/sessions/project/org-1:a%2Fb/sessions/pi/session-1"],
  ])("matches scope ids containing encoded characters: %o %s", (encodedScope, pathname) => {
    assert(isPiSessionsPath(encodedScope, pathname));
  });
});
