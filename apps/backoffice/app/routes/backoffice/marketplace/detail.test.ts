import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

const {
  findBackofficeMeMock,
  requireBackofficeContextMock,
  getPublishedListingMock,
  getArtifactManifestMock,
  listMarketplaceIngestionsMock,
  restartMarketplaceIngestionMock,
  fetchAutomationCollectionSourceMock,
  loadPublishedMarketplaceArtifactExplorerMock,
} = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  requireBackofficeContextMock: vi.fn(),
  getPublishedListingMock: vi.fn(),
  getArtifactManifestMock: vi.fn(),
  listMarketplaceIngestionsMock: vi.fn(),
  restartMarketplaceIngestionMock: vi.fn(),
  fetchAutomationCollectionSourceMock: vi.fn(),
  loadPublishedMarketplaceArtifactExplorerMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));
vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));
vi.mock("@/fragno/automation/tanstack/server", () => ({
  fetchAutomationCollectionSource: fetchAutomationCollectionSourceMock,
}));
vi.mock("@/components/client-only", () => ({
  ClientOnly: ({ children }: { children: () => never }) => children(),
}));
vi.mock("./artifact-files.server", () => ({
  loadPublishedMarketplaceArtifactExplorer: loadPublishedMarketplaceArtifactExplorerMock,
}));
vi.mock("./installation-workflow.client", () => ({
  MarketplaceInstallationWorkflow: ({
    ingestionWorkflowInstanceId,
  }: {
    ingestionWorkflowInstanceId: string;
  }) => `observing:${ingestionWorkflowInstanceId}`,
}));

import {
  backofficeContextScopeRouteId,
  backofficeContextScopeRoutePath,
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { buildMarketplaceIngestionWorkflowInstanceId } from "@/fragno/automation/marketplace-ingest-identity";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

import BackofficeMarketplaceDetail, { action, loader, shouldRevalidate } from "./detail";
import { buildArtifactVersionPath, marketplaceListingRef } from "./navigation";

const listingId = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const listingRef = marketplaceListingRef(listingId);
type IngestionActionDataFixture =
  | { ok: false; message: string }
  | {
      ok: true;
      action: "created" | "restarted" | "unchanged";
      version: string;
      workflowInstanceId: string;
      workflowStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    };
const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", name: "Ada Labs" } },
};
const automations = {
  listMarketplaceIngestions: listMarketplaceIngestionsMock,
  restartMarketplaceIngestion: restartMarketplaceIngestionMock,
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

const runLoader = (
  scope: BackofficeRoutableScope = { kind: "org", orgId: "org-1" },
  artifactVersion?: string,
) => {
  const url = new URL(
    `https://example.test/backoffice/marketplace/${backofficeContextScopeRoutePath(scope)}/marketplace/${listingRef}`,
  );
  if (artifactVersion) {
    url.searchParams.set("artifactVersion", artifactVersion);
  }
  return loader({
    request: new Request(url),
    params: {
      listingRef,
      scopeKind: scope.kind,
      scopeId: backofficeContextScopeRouteId(scope),
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
    `https://example.test/backoffice/marketplace/${backofficeContextScopeRoutePath(scope)}/marketplace/${listingRef}`,
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
      scopeId: backofficeContextScopeRouteId(scope),
    },
    context,
    url,
  } as never);
};

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  requireBackofficeContextMock.mockReset();
  getPublishedListingMock.mockReset();
  getArtifactManifestMock.mockReset();
  listMarketplaceIngestionsMock.mockReset();
  restartMarketplaceIngestionMock.mockReset();
  fetchAutomationCollectionSourceMock.mockReset();
  loadPublishedMarketplaceArtifactExplorerMock.mockReset();
  forOrgMock.mockClear();
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
  requireBackofficeContextMock.mockImplementation(async (_request, _context, scope) => ({
    scope,
    actors: {
      initiator: {
        scope: "internal",
        type: "backoffice",
        id: "interactive",
        role: "initiator",
      },
      principal: {
        scope: "internal",
        type: "user",
        id: authenticatedUser.user.id,
        role: "principal",
      },
      delegation: [],
    },
  }));
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
  fetchAutomationCollectionSourceMock.mockResolvedValue({
    scope: { kind: "org", orgId: "org-1" },
    adapterIdentity: "automations-test-adapter",
  });
  loadPublishedMarketplaceArtifactExplorerMock.mockResolvedValue({
    state: "unavailable",
    message: "This Marketplace listing has no published files.",
  });
  restartMarketplaceIngestionMock.mockResolvedValue({
    listingId,
    version: "1.0.0",
    workflowInstanceId: "marketplace-ingest-1",
    action: "created",
    workflowStatus: "active",
  });
});

describe("marketplace detail loader", () => {
  test("uses the organization selected in the route as the installation location", async () => {
    findBackofficeMeMock.mockResolvedValueOnce({
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
    findBackofficeMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [],
      activeOrganization: null,
    });

    const result = await runLoader({ kind: "user", userId: "user-1" });

    assert(!(result instanceof Response));
    assert(result.installationOrganizationId === null);
    expect(forOrgMock).not.toHaveBeenCalled();
  });

  test("uses a validated artifact version outside the current page for the workflow identity", async () => {
    loadPublishedMarketplaceArtifactExplorerMock.mockResolvedValueOnce({
      state: "ready",
      fileTree: { entries: [] },
      selectedVersion: "1.0.0",
    });

    const result = await runLoader({ kind: "org", orgId: "org-1" }, "1.0.0");

    assert(!(result instanceof Response));
    expect(result.installationWorkflowInstanceId).toBe(
      await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId,
        version: "1.0.0",
      }),
    );
  });

  test("propagates workflow synchronization failures", async () => {
    fetchAutomationCollectionSourceMock.mockRejectedValueOnce(
      new Error("Workflow synchronization failed."),
    );

    await expect(runLoader()).rejects.toThrow("Workflow synchronization failed.");
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

describe("marketplace artifact version navigation", () => {
  test("moves version and installation controls into the package header", () => {
    const markup = renderMarketplaceDetail("2.0.0");

    assert(markup.includes("Version history"));
    assert(markup.includes("Install into"));
    assert(markup.includes(">Install</button>"));
    assert(!markup.includes("Workspace installation"));
  });

  test("offers the selected artifact version when it is outside the current page", () => {
    const markup = renderMarketplaceDetail("1.0.0");

    assert(markup.includes("Version history"));
    assert(markup.includes("v1.0.0"));
    assert(markup.includes('aria-current="page"'));
  });

  test("sorts the version dropdown from newest to oldest", () => {
    const markup = renderMarketplaceDetail("2.0.0", undefined, [
      { version: "1.0.0", publishedAt: "2025-01-01T00:00:00.000Z" },
      { version: "2.0.0", publishedAt: "2026-01-01T00:00:00.000Z" },
      { version: "1.5.0", publishedAt: "2025-06-01T00:00:00.000Z" },
    ]);
    const menuStart = markup.indexOf('class="absolute top-full');
    const versionMenu = markup.slice(menuStart, markup.indexOf("</details>", menuStart));

    assert(menuStart >= 0);
    assert(versionMenu.includes("v2.0.0"));
    assert(versionMenu.includes("v1.5.0"));
    assert(versionMenu.includes("v1.0.0"));
    assert(versionMenu.indexOf("v2.0.0") < versionMenu.indexOf("v1.5.0"));
    assert(versionMenu.indexOf("v1.5.0") < versionMenu.indexOf("v1.0.0"));
  });

  test("observes the workflow started by the submitted release", () => {
    const markup = renderMarketplaceDetail("1.0.0", {
      ok: true,
      action: "created",
      version: "2.0.0",
      workflowInstanceId: "submitted-workflow-id",
      workflowStatus: "active",
    });

    assert(markup.includes("observing:submitted-workflow-id"));
    assert(!markup.includes("observing:loader-workflow-id"));
    assert(!markup.includes("Installation workflow started"));
  });

  test("shows installation request failures in the main area", () => {
    const markup = renderMarketplaceDetail("1.0.0", {
      ok: false,
      message: "Workspace file conflict.",
    });

    assert(markup.includes("Installation could not start"));
    assert(markup.includes("Workspace file conflict."));
  });

  test("keeps the overview tab selected when changing versions", () => {
    const explicitOverviewPath = buildArtifactVersionPath(
      "/backoffice/marketplace/example",
      "?artifactTab=overview&artifactVersion=1.0.0",
      "1.0.0",
      "2.0.0",
    );
    const defaultOverviewPath = buildArtifactVersionPath(
      "/backoffice/marketplace/example",
      "?artifactVersion=1.0.0",
      "1.0.0",
      "2.0.0",
    );

    assert(
      new URL(explicitOverviewPath, "https://example.test").searchParams.get("artifactTab") ===
        "overview",
    );
    assert(
      new URL(defaultOverviewPath, "https://example.test").searchParams.get("artifactTab") === null,
    );
  });

  test("retargets the selected artifact path to the next version", () => {
    const nextPath = buildArtifactVersionPath(
      "/backoffice/marketplace/example",
      "?artifactTab=workflows&artifactVersion=1.0.0&artifactPath=%2Fartifact%2F1.0.0%2Fautomations%2Fdaily-report.workflow.js",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("artifactVersion") === "2.0.0");
    assert(nextUrl.searchParams.get("artifactTab") === "workflows");
    assert(
      nextUrl.searchParams.get("artifactPath") ===
        "/artifact/2.0.0/automations/daily-report.workflow.js",
    );
  });

  test("retargets a selected file to the next version", () => {
    const nextPath = buildArtifactVersionPath(
      "/backoffice/marketplace/example",
      "?artifactTab=files&artifactPath=%2Fartifact%2F1.0.0%2Fsrc%2Findex.ts",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("artifactPath") === "/artifact/2.0.0/src/index.ts");
  });

  test("keeps version-independent artifact paths unchanged", () => {
    const nextPath = buildArtifactVersionPath(
      "/backoffice/marketplace/example",
      "?artifactTab=files&artifactPath=%2Fartifact%2FREADME.md",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("artifactPath") === "/artifact/README.md");
  });
});

describe("marketplace detail revalidation", () => {
  test("uses the default revalidation behavior after form submissions", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL("https://example.test/marketplace/example?artifactTab=files"),
        nextUrl: new URL("https://example.test/marketplace/example?artifactTab=files"),
        formMethod: "POST",
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("skips revalidation when only the artifact selection changes", () => {
    assert(
      !shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=files&artifactPath=%2Fartifact%2F1.0.0%2F",
        ),
        nextUrl: new URL("https://example.test/marketplace/example?artifactTab=workflows"),
        defaultShouldRevalidate: true,
      } as never),
    );
  });
});

function renderMarketplaceDetail(
  selectedVersion: string,
  actionData?: IngestionActionDataFixture,
  versionHistory = [{ version: "2.0.0", publishedAt: "2026-01-01T00:00:00.000Z" }],
): string {
  const loaderData = {
    listing: {
      listingId,
      slug: "telegram-test-command",
      name: "Telegram test command",
      summary: "Run a Telegram command through a published workflow.",
      description: "A published Marketplace listing used to test release selection.",
      tags: [],
      category: "communication",
      publisherName: "Fragno",
      status: "published",
      latestVersion: "2.0.0",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    versions: versionHistory,
    nextVersionCursor: undefined,
    hasNextVersionPage: false,
    manageOrganizationId: null,
    installationOrganizationId: "org-1",
    installationCollectionSource: {
      scope: { kind: "org", orgId: "org-1" },
      adapterIdentity: "automations-test-adapter",
    },
    installationWorkflowInstanceId: "loader-workflow-id",
    artifactFiles: {
      state: "ready",
      fileTree: { entries: [] },
      selectedVersion,
    },
    ingestions: [],
  };
  const router = createMemoryRouter(
    [
      {
        element: createElement(Outlet, {
          context: { selectedScope: { kind: "org", orgId: "org-1", label: "Ada Labs" } },
        }),
        children: [
          {
            id: "marketplace-detail",
            path: "*",
            element: createElement(BackofficeMarketplaceDetail, { loaderData } as never),
          },
        ],
      },
    ],
    {
      initialEntries: [`/marketplace?artifactVersion=${selectedVersion}`],
      ...(actionData
        ? {
            hydrationData: {
              loaderData: {},
              actionData: { "marketplace-detail": actionData },
              errors: null,
            },
          }
        : {}),
    },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("marketplace ingestion action", () => {
  test("starts the full ingestion workflow through its owning service", async () => {
    const result = await runAction({ version: "1.0.0" });

    expect(result).toEqual({
      ok: true,
      action: "created",
      version: "1.0.0",
      workflowInstanceId: "marketplace-ingest-1",
      workflowStatus: "active",
    });
    expect(forOrgMock).toHaveBeenCalledWith("org-1");
    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      {
        listingId,
        targetScope: { kind: "org", orgId: "org-1" },
        version: "1.0.0",
      },
      expect.objectContaining({ propagationContext: null }),
    );
  });

  test("ignores forged destination fields and trusts the selected route scope", async () => {
    await runAction({
      version: "1.0.0",
      extraFormEntries: {
        organizationId: "org-other",
        targetScope: backofficeScopeSinglePathSegment({ kind: "user", userId: "user-2" }),
      },
    });

    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetScope: { kind: "org", orgId: "org-1" },
      }),
      expect.anything(),
    );
  });

  test("starts ingestion into the project selected in the route", async () => {
    const targetScope = { kind: "project", orgId: "org-1", projectId: "project-1" } as const;

    await runAction({ scope: targetScope, version: "1.0.0" });

    expect(forOrgMock).toHaveBeenCalledWith("org-1");
    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetScope }),
      expect.anything(),
    );
  });

  test("restarts the entire deterministic ingestion workflow", async () => {
    restartMarketplaceIngestionMock.mockResolvedValueOnce({
      listingId,
      version: "1.0.0",
      workflowInstanceId: "marketplace-ingest-1",
      action: "restarted",
      workflowStatus: "active",
    });

    const result = await runAction({ version: "1.0.0" });

    expect(result).toEqual({
      ok: true,
      action: "restarted",
      version: "1.0.0",
      workflowInstanceId: "marketplace-ingest-1",
      workflowStatus: "active",
    });
  });

  test("surfaces owning service failures", async () => {
    restartMarketplaceIngestionMock.mockRejectedValueOnce(new Error("Workspace file conflict."));

    const result = await runAction({ version: "1.0.0" });

    expect(result).toEqual({ ok: false, message: "Workspace file conflict." });
  });

  test("rejects another user's personal scope", async () => {
    const result = await runAction({ scope: { kind: "user", userId: "user-2" } });

    expect(result).toEqual({
      ok: false,
      message: "You can only install into your personal workspace.",
    });
    expect(restartMarketplaceIngestionMock).not.toHaveBeenCalled();
  });
});
