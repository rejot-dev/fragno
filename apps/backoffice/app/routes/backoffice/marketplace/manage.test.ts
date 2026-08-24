import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const {
  findBackofficeMeMock,
  addDraftVersionMock,
  archiveListingMock,
  publishVersionMock,
  updateListingMock,
} = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  addDraftVersionMock: vi.fn(),
  archiveListingMock: vi.fn(),
  publishVersionMock: vi.fn(),
  updateListingMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import { marketplaceListingId } from "@/fragno/marketplace/owner";

import { action } from "./manage";
import { marketplaceListingManagePath, marketplaceListingRef } from "./navigation";

const authenticatedUser = {
  user: { id: "user-1" },
  organizations: [{ organization: { id: "org-1", slug: "acme", name: "Acme" } }],
  activeOrganization: { organization: { id: "org-1", slug: "acme", name: "Acme" } },
};

const listingId = marketplaceListingId({
  ownerScope: { kind: "org", orgId: "org-1" },
  slug: "daily-operations-brief",
});

const listingRef = marketplaceListingRef(listingId);

const owner = {
  scope: { kind: "org" as const, orgId: "org-1" },
  publisherName: "Acme",
};
const marketplace = {
  addDraftVersion: addDraftVersionMock,
  archiveListing: archiveListingMock,
  publishVersion: publishVersionMock,
  updateListing: updateListingMock,
};
const context = {
  get: () => ({
    runtime: {
      objects: { marketplace: { singleton: () => marketplace } },
    },
  }),
};

const runAction = (formData: FormData) =>
  action({
    request: new Request(
      new URL(
        marketplaceListingManagePath({ listingId, organizationSlug: "acme" }),
        "https://example.test",
      ),
      { method: "POST", body: formData },
    ),
    params: { listingRef },
    context,
    url: new URL(
      marketplaceListingManagePath({ listingId, organizationSlug: "acme" }),
      "https://example.test",
    ),
  } as never);

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  addDraftVersionMock.mockReset();
  archiveListingMock.mockReset();
  publishVersionMock.mockReset();
  updateListingMock.mockReset();
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
});

describe("marketplace listing management action", () => {
  test("validates and updates mutable catalog metadata", async () => {
    updateListingMock.mockResolvedValue({
      ok: true,
      value: { listingId, slug: "daily-operations-brief" },
    });
    const formData = new FormData();
    formData.set("intent", "update");
    formData.set("organizationSlug", "acme");
    formData.set("name", "Daily operations briefing");
    formData.set("summary", "Build and deliver a concise daily operations briefing.");
    formData.set(
      "description",
      "Collects operational events and produces a daily briefing for the configured channel.",
    );
    formData.set("category", "reporting");
    formData.set("tags", "daily, operations");

    const response = await runAction(formData);

    assert(response instanceof Response);
    assert(response.status === 302);
    expect(updateListingMock).toHaveBeenCalledWith({
      listingId,
      owner,
      metadata: {
        name: "Daily operations briefing",
        summary: "Build and deliver a concise daily operations briefing.",
        description:
          "Collects operational events and produces a daily briefing for the configured channel.",
        category: "reporting",
        tags: ["daily", "operations"],
      },
    });
  });

  test("adds a metadata-only draft version", async () => {
    addDraftVersionMock.mockResolvedValue({
      ok: true,
      value: {
        listingId,
        slug: "daily-operations-brief",
        version: "1.1.0",
        created: true,
      },
    });
    const formData = new FormData();
    formData.set("intent", "add-version");
    formData.set("organizationSlug", "acme");
    formData.set("version", "1.1.0");

    const response = await runAction(formData);

    assert(response instanceof Response);
    expect(addDraftVersionMock).toHaveBeenCalledWith({
      listingId,
      version: "1.1.0",
      owner,
    });
    expect(response.headers.get("location")).toContain("created=1.1.0");
  });

  test("publishes a selected draft version", async () => {
    publishVersionMock.mockResolvedValue({
      ok: true,
      value: {
        listingId,
        slug: "daily-operations-brief",
        version: "1.1.0",
        published: true,
      },
    });
    const formData = new FormData();
    formData.set("intent", "publish");
    formData.set("organizationSlug", "acme");
    formData.set("version", "1.1.0");

    const response = await runAction(formData);

    assert(response instanceof Response);
    expect(publishVersionMock).toHaveBeenCalledWith({
      listingId,
      version: "1.1.0",
      owner,
    });
    expect(response.headers.get("location")).toContain("published=1.1.0");
  });

  test("returns stable marketplace operation failures", async () => {
    publishVersionMock.mockResolvedValue({
      ok: false,
      error: {
        code: "MARKETPLACE_VERSION_NOT_FOUND",
        message: "Marketplace version daily-operations-brief@2.0.0 was not found.",
      },
    });
    const formData = new FormData();
    formData.set("intent", "publish");
    formData.set("organizationSlug", "acme");
    formData.set("version", "2.0.0");

    await expect(runAction(formData)).resolves.toEqual({
      ok: false,
      message: "Marketplace version daily-operations-brief@2.0.0 was not found.",
    });
  });

  test("archives the listing without touching automation workspaces", async () => {
    archiveListingMock.mockResolvedValue({
      ok: true,
      value: { listingId, slug: "daily-operations-brief", archived: true },
    });
    const formData = new FormData();
    formData.set("intent", "archive");
    formData.set("organizationSlug", "acme");

    const response = await runAction(formData);

    assert(response instanceof Response);
    expect(archiveListingMock).toHaveBeenCalledWith({
      listingId,
      owner,
    });
    expect(addDraftVersionMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("archived=1");
  });
});
