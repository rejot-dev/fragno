import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  getAuthMeMock,
  getPublishedListingMock,
  getArtifactManifestMock,
  listMarketplaceIngestionsMock,
  requestMarketplaceIngestionMock,
} = vi.hoisted(() => ({
  getAuthMeMock: vi.fn(),
  getPublishedListingMock: vi.fn(),
  getArtifactManifestMock: vi.fn(),
  listMarketplaceIngestionsMock: vi.fn(),
  requestMarketplaceIngestionMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ getAuthMe: getAuthMeMock }));

import {
  backofficeScopeRouteId,
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

import { action, loader } from "./detail";
import { marketplaceListingRef } from "./navigation";

const listingId = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const listingRef = marketplaceListingRef(listingId);
const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", name: "Ada Labs" } },
};
const automations = {
  listMarketplaceIngestions: listMarketplaceIngestionsMock,
  requestMarketplaceIngestion: requestMarketplaceIngestionMock,
};
const forOrgMock = vi.fn(() => automations);
const marketplace = {
  getPublishedListing: getPublishedListingMock,
  getArtifactManifest: getArtifactManifestMock,
};
const context = {
  get: () => ({
    runtime: {
      objects: {
        automations: { forOrg: forOrgMock },
        marketplace: { singleton: () => marketplace },
      },
    },
  }),
};

const runLoader = (scope: BackofficeRoutableScope = { kind: "org", orgId: "org-1" }) => {
  const url = new URL(
    `https://example.test/backoffice/marketplace/${scope.kind}/${backofficeScopeRouteId(scope)}/marketplace/${listingRef}`,
  );
  return loader({
    request: new Request(url),
    params: {
      listingRef,
      scopeKind: scope.kind,
      scopeId: backofficeScopeRouteId(scope),
    },
    context,
    url,
  } as never);
};

const runAction = (input: {
  scope?: BackofficeRoutableScope;
  version?: string;
  extraFormEntries?: Record<string, string>;
}) => {
  const scope = input.scope ?? { kind: "org", orgId: "org-1" };
  const url = new URL(
    `https://example.test/backoffice/marketplace/${scope.kind}/${backofficeScopeRouteId(scope)}/marketplace/${listingRef}`,
  );
  const formData = new FormData();
  if (input.version) {
    formData.set("version", input.version);
  }
  for (const [name, value] of Object.entries(input.extraFormEntries ?? {})) {
    formData.set(name, value);
  }
  return action({
    request: new Request(url, {
      method: "POST",
      body: formData,
    }),
    params: {
      listingRef,
      scopeKind: scope.kind,
      scopeId: backofficeScopeRouteId(scope),
    },
    context,
    url,
  } as never);
};

beforeEach(() => {
  getAuthMeMock.mockReset();
  getPublishedListingMock.mockReset();
  getArtifactManifestMock.mockReset();
  listMarketplaceIngestionsMock.mockReset();
  requestMarketplaceIngestionMock.mockReset();
  forOrgMock.mockClear();
  getAuthMeMock.mockResolvedValue(authenticatedUser);
  getPublishedListingMock.mockResolvedValue({
    listing: {
      listingId,
      slug: "telegram-test-command",
      latestVersion: "2.0.0",
    },
    versions: [],
    nextVersionCursor: null,
    hasNextVersionPage: false,
  });
  getArtifactManifestMock.mockResolvedValue(null);
  listMarketplaceIngestionsMock.mockResolvedValue([]);
  requestMarketplaceIngestionMock.mockResolvedValue({
    listingId,
    version: "1.0.0",
    workflowInstanceId: "marketplace-ingest-1",
    state: "requested",
    workflowStatus: "active",
  });
});

describe("marketplace detail loader", () => {
  test("uses the organization selected in the route as the installation location", async () => {
    getAuthMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [
        authenticatedUser.organizations[0],
        { organization: { id: "org-2", name: "Second Labs" } },
      ],
    });
    listMarketplaceIngestionsMock.mockResolvedValueOnce([
      {
        id: "selected-installation",
        listingId,
        targetScopeKey: backofficeScopeSinglePathSegment({ kind: "org", orgId: "org-2" }),
        version: "1.0.0",
      },
      {
        id: "other-scope",
        listingId,
        targetScopeKey: backofficeScopeSinglePathSegment({ kind: "org", orgId: "org-1" }),
        version: "1.0.0",
      },
    ]);

    const result = await runLoader({ kind: "org", orgId: "org-2" });

    assert(!(result instanceof Response));
    assert(result.installationOrganizationId === "org-2");
    expect(result.ingestions).toEqual([
      expect.objectContaining({
        id: "selected-installation",
        organizationName: "Second Labs",
        latestVersion: "2.0.0",
        outOfDate: true,
      }),
    ]);
    expect(forOrgMock).toHaveBeenCalledWith("org-2");
    expect(listMarketplaceIngestionsMock).toHaveBeenCalledWith({
      targetScope: { kind: "org", orgId: "org-2" },
    });
  });

  test("uses the selected project's organization as the workflow coordinator", async () => {
    const result = await runLoader({
      kind: "project",
      orgId: "org-1",
      projectId: "project-1",
    });

    assert(!(result instanceof Response));
    assert(result.installationOrganizationId === "org-1");
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
  });

  test("uses the active organization to coordinate a personal-scope installation", async () => {
    const result = await runLoader({ kind: "user", userId: "user-1" });

    assert(!(result instanceof Response));
    assert(result.installationOrganizationId === "org-1");
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
  });

  test("disables personal-scope installation when the user has no organization", async () => {
    getAuthMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [],
      activeOrganization: null,
    });

    const result = await runLoader({ kind: "user", userId: "user-1" });

    assert(!(result instanceof Response));
    assert(result.installationOrganizationId === null);
    expect(forOrgMock).not.toHaveBeenCalled();
  });

  test("rejects an organization scope outside the authenticated memberships", async () => {
    const response = await runLoader({ kind: "org", orgId: "org-other" }).catch(
      (error: unknown) => error,
    );

    assert(response instanceof Response);
    assert(response.status === 404);
    expect(forOrgMock).not.toHaveBeenCalled();
  });
});

describe("marketplace ingestion action", () => {
  test("requests ingestion into the organization selected in the route", async () => {
    const result = await runAction({ version: "1.0.0" });

    expect(result).toMatchObject({ ok: true, result: { state: "requested" } });
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
    expect(requestMarketplaceIngestionMock).toHaveBeenCalledWith({
      listingId,
      targetScope: { kind: "org", orgId: "org-1" },
      version: "1.0.0",
    });
  });

  test("ignores forged destination fields and trusts the selected route scope", async () => {
    const result = await runAction({
      extraFormEntries: {
        organizationId: "org-other",
        targetScope: backofficeScopeSinglePathSegment({ kind: "user", userId: "user-2" }),
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
    expect(requestMarketplaceIngestionMock).toHaveBeenCalledWith({
      listingId,
      targetScope: { kind: "org", orgId: "org-1" },
      version: undefined,
    });
  });

  test("requests ingestion into the project selected in the route", async () => {
    const targetScope = { kind: "project", orgId: "org-1", projectId: "project-1" } as const;

    const result = await runAction({ scope: targetScope });

    expect(result).toMatchObject({ ok: true });
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
    expect(requestMarketplaceIngestionMock).toHaveBeenCalledWith({
      listingId,
      targetScope,
      version: undefined,
    });
  });

  test("surfaces failed workflow results as action failures", async () => {
    requestMarketplaceIngestionMock.mockResolvedValueOnce({
      listingId,
      version: "1.0.0",
      workflowInstanceId: "marketplace-ingest-1",
      state: "failed",
      workflowStatus: "errored",
      error: { name: "Error", message: "Workspace file conflict." },
    });

    const result = await runAction({ version: "1.0.0" });

    expect(result).toEqual({ ok: false, message: "Workspace file conflict." });
  });

  test("rejects another user's personal scope", async () => {
    const result = await runAction({ scope: { kind: "user", userId: "user-2" } });

    expect(result).toEqual({
      ok: false,
      message: "You can only install into your personal workspace.",
    });
    expect(requestMarketplaceIngestionMock).not.toHaveBeenCalled();
  });
});
