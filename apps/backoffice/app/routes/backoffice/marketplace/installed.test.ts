import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock, getLatestPublishedVersionsMock, listMarketplaceIngestionsMock } =
  vi.hoisted(() => ({
    findBackofficeMeMock: vi.fn(),
    getLatestPublishedVersionsMock: vi.fn(),
    listMarketplaceIngestionsMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import { loader } from "./installed";

const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
};
const automations = {
  listMarketplaceIngestions: listMarketplaceIngestionsMock,
};
const forOrgMock = vi.fn(() => automations);
const marketplace = {
  getLatestPublishedVersions: getLatestPublishedVersionsMock,
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

const runLoader = (scopeKind = "org", scopeId = "ada-labs") => {
  const url = new URL(
    `https://example.test/backoffice/marketplace/${scopeKind}/${scopeId}/installed`,
  );
  return loader({
    request: new Request(url),
    params: { scopeKind, scopeId },
    context,
    url,
  } as never);
};

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  getLatestPublishedVersionsMock.mockReset();
  listMarketplaceIngestionsMock.mockReset();
  forOrgMock.mockClear();
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
  listMarketplaceIngestionsMock.mockResolvedValue([]);
  getLatestPublishedVersionsMock.mockResolvedValue({});
});

describe("installed Marketplace loader", () => {
  test("joins local ingestions with latest Marketplace versions and derives update state", async () => {
    listMarketplaceIngestionsMock.mockResolvedValueOnce([
      {
        id: "org:org-1#system#telegram-test-command",
        targetScopeKey: "org:org-1",
        listingId: "system#telegram-test-command",
        version: "1.0.0",
      },
      {
        id: "org:org-1#system#daily-report",
        targetScopeKey: "org:org-1",
        listingId: "system#daily-report",
        version: "2.0.0",
      },
    ]);
    getLatestPublishedVersionsMock.mockResolvedValueOnce({
      "system#telegram-test-command": "2.0.0",
      "system#daily-report": "2.0.0",
    });

    const result = await runLoader();

    assert(!(result instanceof Response));
    expect(listMarketplaceIngestionsMock).toHaveBeenCalledWith({
      targetScope: { kind: "org", orgId: "org-1" },
    });
    expect(getLatestPublishedVersionsMock).toHaveBeenCalledWith({
      listingIds: ["system#telegram-test-command", "system#daily-report"],
    });
    expect(result.ingestions).toEqual([
      expect.objectContaining({
        listingId: "system#telegram-test-command",
        version: "1.0.0",
        latestVersion: "2.0.0",
        outOfDate: true,
      }),
      expect.objectContaining({
        listingId: "system#daily-report",
        version: "2.0.0",
        latestVersion: "2.0.0",
        outOfDate: false,
      }),
    ]);
  });

  test("chunks latest-version lookups at the Marketplace service limit", async () => {
    const ingestions = Array.from({ length: 501 }, (_, index) => ({
      id: `org:org-1#system#listing-${index}`,
      targetScopeKey: "org:org-1",
      listingId: `system#listing-${index}`,
      version: "1.0.0",
    }));
    listMarketplaceIngestionsMock.mockResolvedValueOnce(ingestions);
    getLatestPublishedVersionsMock.mockImplementation(
      async ({ listingIds }: { listingIds: string[] }) =>
        Object.fromEntries(listingIds.map((listingId) => [listingId, "1.1.0"])),
    );

    const result = await runLoader();

    assert(!(result instanceof Response));
    expect(getLatestPublishedVersionsMock).toHaveBeenCalledTimes(2);
    expect(getLatestPublishedVersionsMock.mock.calls[0]?.[0].listingIds).toEqual(
      ingestions.slice(0, 500).map(({ listingId }) => listingId),
    );
    expect(getLatestPublishedVersionsMock.mock.calls[1]?.[0].listingIds).toEqual([
      ingestions[500]?.listingId,
    ]);
    expect(result.ingestions).toHaveLength(501);
    expect(result.ingestions.at(-1)).toMatchObject({
      latestVersion: "1.1.0",
      outOfDate: true,
    });
  });

  test("does not call Marketplace when the selected target has no ingestions", async () => {
    const result = await runLoader();

    assert(!(result instanceof Response));
    expect(result.ingestions).toEqual([]);
    expect(getLatestPublishedVersionsMock).not.toHaveBeenCalled();
  });

  test("reads personal-workspace ingestion state from every organization coordinator", async () => {
    findBackofficeMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [
        { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
        { organization: { id: "org-2", name: "Second Labs" } },
      ],
    });
    listMarketplaceIngestionsMock
      .mockResolvedValueOnce([
        {
          id: "user:user-1#system#telegram-test-command",
          targetScopeKey: "user:user-1",
          listingId: "system#telegram-test-command",
          version: "1.0.0",
        },
      ])
      .mockResolvedValueOnce([]);
    getLatestPublishedVersionsMock.mockResolvedValueOnce({
      "system#telegram-test-command": "1.0.0",
    });

    const result = await runLoader("user", "user-1");

    assert(!(result instanceof Response));
    expect(forOrgMock.mock.calls).toEqual([["org-1"], ["org-2"]]);
    expect(listMarketplaceIngestionsMock).toHaveBeenCalledTimes(2);
    expect(result.ingestions[0]).toMatchObject({
      organizationId: "org-1",
      organizationName: "Ada Labs",
      outOfDate: false,
    });
  });
});
