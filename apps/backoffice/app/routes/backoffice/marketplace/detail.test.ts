import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  fetchAutomationProjectsMock,
  getAuthMeMock,
  getPublishedListingMock,
  listMarketplaceIngestionsMock,
  requestMarketplaceIngestionMock,
} = vi.hoisted(() => ({
  fetchAutomationProjectsMock: vi.fn(),
  getAuthMeMock: vi.fn(),
  getPublishedListingMock: vi.fn(),
  listMarketplaceIngestionsMock: vi.fn(),
  requestMarketplaceIngestionMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ getAuthMe: getAuthMeMock }));
vi.mock("../automations/data.server", () => ({
  fetchAutomationProjects: fetchAutomationProjectsMock,
  toExternalId: (id: { valueOf(): string }) => id.valueOf(),
}));

import { backofficeScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
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
const marketplace = {
  getPublishedListing: getPublishedListingMock,
};
const context = {
  get: () => ({
    runtime: {
      objects: {
        automations: { forOrg: () => automations },
        marketplace: { singleton: () => marketplace },
      },
    },
  }),
};

const detailUrl = `https://example.test/backoffice/marketplace/${listingRef}`;

const runLoader = () =>
  loader({
    request: new Request(detailUrl),
    params: { listingRef },
    context,
    url: new URL(detailUrl),
  } as never);

const runAction = (input: { organizationId: string; targetScope: string; version?: string }) => {
  const formData = new FormData();
  formData.set("organizationId", input.organizationId);
  formData.set("targetScope", input.targetScope);
  if (input.version) {
    formData.set("version", input.version);
  }
  return action({
    request: new Request(detailUrl, {
      method: "POST",
      body: formData,
    }),
    params: { listingRef },
    context,
    url: new URL(detailUrl),
  } as never);
};

beforeEach(() => {
  fetchAutomationProjectsMock.mockReset();
  getAuthMeMock.mockReset();
  getPublishedListingMock.mockReset();
  listMarketplaceIngestionsMock.mockReset();
  requestMarketplaceIngestionMock.mockReset();
  fetchAutomationProjectsMock.mockResolvedValue({ projects: [], projectsError: null });
  getAuthMeMock.mockResolvedValue(authenticatedUser);
  getPublishedListingMock.mockResolvedValue({
    listing: {
      listingId,
      slug: "telegram-test-command",
    },
    versions: [],
    nextVersionCursor: null,
    hasNextVersionPage: false,
  });
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
  test("fails when organization projects cannot be loaded", async () => {
    fetchAutomationProjectsMock.mockResolvedValueOnce({
      projects: [],
      projectsError: "Failed to load automation projects.",
    });

    const response = await runLoader().catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    assert((response as Response).status === 502);
    await expect((response as Response).text()).resolves.toBe(
      "Failed to load automation projects.",
    );
  });
});

describe("marketplace ingestion action", () => {
  test("requests ingestion into an authenticated organization workspace", async () => {
    const result = await runAction({
      organizationId: "org-1",
      targetScope: backofficeScopeSinglePathSegment({ kind: "org", orgId: "org-1" }),
      version: "1.0.0",
    });

    expect(result).toMatchObject({ ok: true, result: { state: "requested" } });
    expect(requestMarketplaceIngestionMock).toHaveBeenCalledWith({
      listingId,
      targetScope: { kind: "org", orgId: "org-1" },
      version: "1.0.0",
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

    const result = await runAction({
      organizationId: "org-1",
      targetScope: backofficeScopeSinglePathSegment({ kind: "org", orgId: "org-1" }),
      version: "1.0.0",
    });

    expect(result).toEqual({ ok: false, message: "Workspace file conflict." });
  });

  test("surfaces project destination rejection from Automations", async () => {
    requestMarketplaceIngestionMock.mockRejectedValueOnce(
      new Error("Marketplace ingestion target belongs to another organization."),
    );

    const result = await runAction({
      organizationId: "org-1",
      targetScope: backofficeScopeSinglePathSegment({
        kind: "project",
        orgId: "org-2",
        projectId: "project-1",
      }),
    });

    expect(result).toEqual({
      ok: false,
      message: "Marketplace ingestion target belongs to another organization.",
    });
    expect(requestMarketplaceIngestionMock).toHaveBeenCalledOnce();
  });

  test("rejects another user's personal workspace", async () => {
    const result = await runAction({
      organizationId: "org-1",
      targetScope: backofficeScopeSinglePathSegment({ kind: "user", userId: "user-2" }),
    });

    expect(result).toEqual({
      ok: false,
      message: "You can only select your personal workspace.",
    });
    expect(requestMarketplaceIngestionMock).not.toHaveBeenCalled();
  });
});
