import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import {
  type BackofficeRoutableScope,
  backofficeScopeOrganization,
  backofficeScopePathSegment,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider, RouterContextProvider } from "react-router";

import { createBackofficeRequestExecution } from "@/backoffice-runtime/context";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const {
  shellMeMock,
  requireBackofficeContextMock,
  getPublishedListingMock,
  getListingStorageMock,
  restartMarketplaceIngestionMock,
  fetchAutomationReplicaSourceMock,
  loadPublishedMarketplacePackageExplorerMock,
} = vi.hoisted(() => ({
  shellMeMock: vi.fn(),
  requireBackofficeContextMock: vi.fn(),
  getPublishedListingMock: vi.fn(),
  getListingStorageMock: vi.fn(),
  restartMarketplaceIngestionMock: vi.fn(),
  fetchAutomationReplicaSourceMock: vi.fn(),
  loadPublishedMarketplacePackageExplorerMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));
vi.mock("@/fragno/automation/lofi/replica-source.server", () => ({
  fetchAutomationReplicaSource: fetchAutomationReplicaSourceMock,
}));
vi.mock("@fragno-private/design-system/client-only", () => ({
  ClientOnly: ({ children }: { children: () => never }) => children(),
}));
vi.mock("./package-files.server", () => ({
  loadPublishedMarketplacePackageExplorer: loadPublishedMarketplacePackageExplorerMock,
}));
vi.mock("./installation-workflow.client", () => ({
  MarketplaceInstallationWorkflow: ({
    ingestionWorkflowInstanceId,
  }: {
    ingestionWorkflowInstanceId: string;
  }) => `observing:${ingestionWorkflowInstanceId}`,
}));

import {
  backofficeRouteScopePath,
  type BackofficeRoutableRouteScope,
} from "@/backoffice-runtime/route-scope";
import { buildMarketplacePackageInstallWorkflowInstanceId } from "@/fragno/automation/marketplace-package-install-identity";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

import BackofficeMarketplaceDetail, { action, loader, shouldRevalidate } from "./detail";
import {
  buildMarketplaceInstallationPath,
  readMarketplaceInstallationReference,
  type MarketplaceInstallationReference,
} from "./installation-reference";
import { buildPackageVersionPath } from "./navigation";

const listingId = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const listingRef = "system/telegram-test-command";
type IngestionActionDataFixture = { ok: false; message: string };
const installationReference = {
  organizationId: "org-1",
  version: "1.3.0",
  installationRoot: "/workspace/custom-telegram",
} satisfies MarketplaceInstallationReference;
const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
};
const automations = {
  restartMarketplaceIngestion: restartMarketplaceIngestionMock,
};
const automationsForMock = vi.fn(() => ({ commands: automations }));
const marketplace = {
  getPublishedListing: getPublishedListingMock,
  getListingStorage: getListingStorageMock,
};
const workerContext = {
  runtime: {
    objects: {
      automations: { for: automationsForMock },
      marketplace: { for: () => ({ commands: marketplace }) },
    },
  },
};

const knownOrganizations = [
  { id: "org-1", slug: "ada-labs", jurisdiction: null },
  { id: "org-2", slug: "second-labs", jurisdiction: null },
];

function slugOf(orgId: string): string {
  return knownOrganizations.find(({ id }) => id === orgId)?.slug ?? `unknown-${orgId}`;
}

function routeScopeForTest(scope: BackofficeRoutableScope): BackofficeRoutableRouteScope {
  return mapBackofficeScopeNames(scope, {
    organization: ({ orgId }) => ({ orgSlug: slugOf(orgId) }),
    user: ({ userId }) => ({ userId }),
    project: ({ projectId }) => ({ projectSlug: projectId }),
  });
}

/** The request context after the Backoffice layout established the signed-in user and route scope. */
async function routeContext(scope: BackofficeRoutableScope) {
  const me = (await shellMeMock()) as typeof authenticatedUser;
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, workerContext as never);
  const orgId = backofficeScopeOrganization(scope)?.orgId;
  const organization = knownOrganizations.find(({ id }) => id === orgId);
  const routeScope =
    orgId && !organization
      ? null
      : mapBackofficeScopeNames(scope, {
          organization: () => ({ organization }),
          user: ({ userId, jurisdiction }) => ({ userId, jurisdiction }),
          project: ({ projectId }) => ({
            project: { id: projectId, slug: projectId, name: projectId },
          }),
        });
  provideBackofficeShellRequest(context, {
    me: me as unknown as BackofficeMeData,
    routeScope: routeScope as never,
  });
  return context;
}

const runLoader = async (
  scope: BackofficeRoutableScope = { kind: "org", orgId: "org-1", jurisdiction: null },
  packageVersion?: string,
  installation?: MarketplaceInstallationReference,
) => {
  const routeScope = routeScopeForTest(scope);
  const routePath = backofficeRouteScopePath(routeScope);
  const url = new URL(
    `https://example.test/backoffice/marketplace/${routePath}/marketplace/${listingRef}`,
  );
  if (packageVersion) {
    url.searchParams.set("packageVersion", packageVersion);
  }
  if (installation) {
    url.searchParams.set("installation", JSON.stringify(installation));
  }
  return loader({
    request: new Request(url),
    params: {
      publisher: "system",
      packageSlug: "telegram-test-command",
      catalog: "marketplace",
      scopeKind: routeScope.kind,
      scopeId: decodeURIComponent(routePath.split("/")[1]!),
    },
    context: await routeContext(scope),
    url,
  } as never);
};

const runAction = async (input: {
  scope?: BackofficeRoutableScope;
  version?: string;
  extraFormEntries?: Record<string, string>;
}) => {
  const scope = input.scope ?? { kind: "org", orgId: "org-1", jurisdiction: null };
  const routeScope = routeScopeForTest(scope);
  const routePath = backofficeRouteScopePath(routeScope);
  const url = new URL(
    `https://example.test/backoffice/marketplace/${routePath}/marketplace/${listingRef}`,
  );
  const formData = new FormData();
  formData.set("installationRoot", "/workspace/telegram-test-command");
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
      publisher: "system",
      packageSlug: "telegram-test-command",
      catalog: "marketplace",
      scopeKind: routeScope.kind,
      scopeId: decodeURIComponent(routePath.split("/")[1]!),
    },
    context: await routeContext(scope),
    url,
  } as never);
};

beforeEach(() => {
  shellMeMock.mockReset();
  requireBackofficeContextMock.mockReset();
  getPublishedListingMock.mockReset();
  getListingStorageMock.mockReset();
  restartMarketplaceIngestionMock.mockReset();
  fetchAutomationReplicaSourceMock.mockReset();
  loadPublishedMarketplacePackageExplorerMock.mockReset();
  automationsForMock.mockClear();
  shellMeMock.mockResolvedValue(authenticatedUser);
  requireBackofficeContextMock.mockImplementation(async (_request, _context, scope) =>
    createBackofficeRequestExecution({
      scope,
      verifiedRequestAuthority: {
        userId: authenticatedUser.user.id,
        personalScope: {
          kind: "user" as const,
          userId: authenticatedUser.user.id,
          jurisdiction: null,
        },
        role: "user",
        organization: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
        administeredMember: null,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        scopeRestriction: null,
      },
    }),
  );
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
  getListingStorageMock.mockResolvedValue(null);
  fetchAutomationReplicaSourceMock.mockImplementation(
    async (_request, _context, resolvedScope) => ({
      resolvedScope,
      adapterIdentity: "automations-test-adapter",
    }),
  );
  loadPublishedMarketplacePackageExplorerMock.mockResolvedValue({
    state: "unavailable",
    message: "This Marketplace listing has no published files.",
  });
  restartMarketplaceIngestionMock.mockResolvedValue({
    listingId,
    version: "1.0.0",
    workflowInstanceId: "marketplace-package-install-1",
    action: "created",
    workflowStatus: "active",
  });
});

describe("marketplace detail loader", () => {
  test("uses the organization selected in the route as the installation location", async () => {
    shellMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [
        authenticatedUser.organizations[0],
        { organization: { id: "org-2", slug: "second-labs", name: "Second Labs" } },
      ],
    });
    const result = await runLoader({ kind: "org", orgId: "org-2", jurisdiction: null });

    assert(!(result instanceof Response));
    assert(result.installationCollectionSource?.resolvedScope.kind === "org");
    assert(result.installationCollectionSource.resolvedScope.organization.id === "org-2");
  });

  test("uses the selected project's organization as the workflow coordinator", async () => {
    const result = await runLoader({
      kind: "project",
      owner: { kind: "org", orgId: "org-1", jurisdiction: null },
      projectId: "project-1",
    });

    assert(!(result instanceof Response));
    assert(result.installationCollectionSource?.resolvedScope.kind === "org");
    assert(result.installationCollectionSource.resolvedScope.organization.id === "org-1");
  });

  test("uses the active organization to coordinate a personal-scope installation", async () => {
    const result = await runLoader({ kind: "user", userId: "user-1", jurisdiction: null });

    assert(!(result instanceof Response));
    assert(result.installationCollectionSource?.resolvedScope.kind === "org");
    assert(result.installationCollectionSource.resolvedScope.organization.id === "org-1");
  });

  test("disables personal-scope installation when the user has no organization", async () => {
    shellMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [],
      activeOrganization: null,
    });

    const result = await runLoader({ kind: "user", userId: "user-1", jurisdiction: null });

    assert(!(result instanceof Response));
    assert(result.installationCollectionSource === null);
    expect(automationsForMock).not.toHaveBeenCalled();
  });

  test("loads a validated package version outside the current page", async () => {
    loadPublishedMarketplacePackageExplorerMock.mockResolvedValueOnce({
      state: "ready",
      fileTree: { entries: [] },
      selectedVersion: "1.0.0",
    });

    const result = await runLoader({ kind: "org", orgId: "org-1", jurisdiction: null }, "1.0.0");

    assert(!(result instanceof Response));
    assert(result.packageFiles.state === "ready");
    assert(result.packageFiles.selectedVersion === "1.0.0");
  });

  test.each([
    { kind: "org", orgId: "org-1", jurisdiction: null },
    {
      kind: "project",
      owner: { kind: "org", orgId: "org-1", jurisdiction: null },
      projectId: "project-1",
    },
    { kind: "user", userId: "user-1", jurisdiction: null },
  ] as const)("recovers an interactive installation on reload in $kind scope", async (scope) => {
    const result = await runLoader(scope, installationReference.version, installationReference);
    assert(!(result instanceof Response));
    expect(result.installationReference).toEqual({
      ...installationReference,
      workflowInstanceId: await buildMarketplacePackageInstallWorkflowInstanceId({
        marketplace: { kind: "system" },
        targetScope: scope,
        listingId,
        installationRoot: installationReference.installationRoot,
        version: installationReference.version,
      }),
    });
    expect(restartMarketplaceIngestionMock).not.toHaveBeenCalled();
  });

  test("personal reload keeps the original coordinator after the active organization changes", async () => {
    shellMeMock.mockResolvedValueOnce({
      ...authenticatedUser,
      organizations: [
        ...authenticatedUser.organizations,
        { organization: { id: "org-2", slug: "second-labs", name: "Second Labs" } },
      ],
      activeOrganization: {
        organization: { id: "org-2", slug: "second-labs", name: "Second Labs" },
      },
    });
    const result = await runLoader(
      { kind: "user", userId: "user-1", jurisdiction: null },
      undefined,
      installationReference,
    );
    assert(!(result instanceof Response));
    assert(result.installationCollectionSource?.resolvedScope.kind === "org");
    assert(result.installationCollectionSource.resolvedScope.organization.id === "org-1");
  });

  test("rejects a persisted coordinator outside the destination organization", async () => {
    const response = await runLoader(
      { kind: "org", orgId: "org-1", jurisdiction: null },
      undefined,
      {
        ...installationReference,
        organizationId: "org-other",
      },
    ).catch((error: unknown) => error);
    assert(response instanceof Response);
    assert(response.status === 404);
    expect(fetchAutomationReplicaSourceMock).not.toHaveBeenCalled();
  });

  test("rejects a persisted personal coordinator after membership is removed", async () => {
    const response = await runLoader(
      { kind: "user", userId: "user-1", jurisdiction: null },
      undefined,
      {
        ...installationReference,
        organizationId: "org-other",
      },
    ).catch((error: unknown) => error);
    assert(response instanceof Response);
    assert(response.status === 404);
    expect(fetchAutomationReplicaSourceMock).not.toHaveBeenCalled();
  });

  test("rejects invalid persisted installation paths before loading workflow data", async () => {
    const response = await runLoader(
      { kind: "org", orgId: "org-1", jurisdiction: null },
      undefined,
      {
        ...installationReference,
        installationRoot: "/workspace/../private",
      },
    ).catch((error: unknown) => error);
    assert(response instanceof Response);
    assert(response.status === 400);
    expect(fetchAutomationReplicaSourceMock).not.toHaveBeenCalled();
  });

  test("propagates workflow synchronization failures", async () => {
    fetchAutomationReplicaSourceMock.mockRejectedValueOnce(
      new Error("Workflow synchronization failed."),
    );

    await expect(runLoader()).rejects.toThrow("Workflow synchronization failed.");
  });
});

describe("marketplace package version navigation", () => {
  test("tab and version navigation retain the persisted installer until dismissal", () => {
    const path = buildMarketplaceInstallationPath(
      "/marketplace",
      "?packagePath=/package/1.0.0/file",
      installationReference,
    );
    const initial = new URL(path, "https://example.test");
    const switched = buildPackageVersionPath(
      initial.pathname,
      initial.search,
      installationReference.version,
      "2.0.0",
    );
    const switchedUrl = new URL(switched, "https://example.test");
    expect(readMarketplaceInstallationReference(switchedUrl.search)).toEqual(installationReference);
    const closed = new URL(
      buildMarketplaceInstallationPath(switchedUrl.pathname, switchedUrl.search, null),
      "https://example.test",
    );
    assert(readMarketplaceInstallationReference(closed.search) === null);
    assert(closed.searchParams.get("packageTab") === "install");
    assert(closed.searchParams.get("packageVersion") === "2.0.0");
    const markup = renderMarketplaceDetail("2.0.0", undefined, undefined, "install");
    assert(markup.includes('name="installationRoot"'));
    assert(!markup.includes("observing:"));
  });
  test("keeps a simple header action and puts installation controls in their own tab", () => {
    const markup = renderMarketplaceDetail("2.0.0");
    assert(markup.includes("Version history"));
    assert(markup.includes('aria-label="Marketplace package sections"'));
    assert(markup.includes("Overview"));
    assert(markup.includes("Workflows"));
    assert(markup.includes("Files"));
    assert(markup.includes(">Install</a>"));
    assert(!markup.includes('name="installationRoot"'));
    assert(!markup.includes("Latest version"));

    const installMarkup = renderMarketplaceDetail("2.0.0", undefined, undefined, "install");
    assert(installMarkup.includes('name="installationRoot"'));
    assert(installMarkup.includes('value="/workspace/telegram-test-command"'));
    assert(installMarkup.includes("A workspace holds one"));
    assert(installMarkup.includes(">Install</button>"));
    assert(installMarkup.includes("Ada Labs"));
  });

  test("offers the selected package version when it is outside the current page", () => {
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

  test("observes the persisted installation without any transient action data", () => {
    const markup = renderMarketplaceDetail("1.0.0", undefined, undefined, "install", {
      ...installationReference,
      workflowInstanceId: "persisted-workflow-id",
    });

    assert(markup.includes("observing:persisted-workflow-id"));
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
    const explicitOverviewPath = buildPackageVersionPath(
      "/backoffice/marketplace/example",
      "?packageTab=overview&packageVersion=1.0.0",
      "1.0.0",
      "2.0.0",
    );
    const defaultOverviewPath = buildPackageVersionPath(
      "/backoffice/marketplace/example",
      "?packageVersion=1.0.0",
      "1.0.0",
      "2.0.0",
    );

    assert(
      new URL(explicitOverviewPath, "https://example.test").searchParams.get("packageTab") ===
        "overview",
    );
    assert(
      new URL(defaultOverviewPath, "https://example.test").searchParams.get("packageTab") === null,
    );
  });

  test("retargets the selected package path to the next version", () => {
    const nextPath = buildPackageVersionPath(
      "/backoffice/marketplace/example",
      "?packageTab=workflows&packageVersion=1.0.0&packagePath=%2Fpackage%2F1.0.0%2Fautomations%2Fdaily-report.workflow.js",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("packageVersion") === "2.0.0");
    assert(nextUrl.searchParams.get("packageTab") === "workflows");
    assert(
      nextUrl.searchParams.get("packagePath") ===
        "/package/2.0.0/automations/daily-report.workflow.js",
    );
  });

  test("retargets a selected file to the next version", () => {
    const nextPath = buildPackageVersionPath(
      "/backoffice/marketplace/example",
      "?packageTab=files&packagePath=%2Fpackage%2F1.0.0%2Fsrc%2Findex.ts",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("packagePath") === "/package/2.0.0/src/index.ts");
  });

  test("keeps version-independent package paths unchanged", () => {
    const nextPath = buildPackageVersionPath(
      "/backoffice/marketplace/example",
      "?packageTab=files&packagePath=%2Fpackage%2FREADME.md",
      "1.0.0",
      "2.0.0",
    );
    const nextUrl = new URL(nextPath, "https://example.test");

    assert(nextUrl.searchParams.get("packagePath") === "/package/README.md");
  });
});

describe("marketplace detail revalidation", () => {
  test("uses the default revalidation behavior after form submissions", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL("https://example.test/marketplace/example?packageTab=files"),
        nextUrl: new URL("https://example.test/marketplace/example?packageTab=files"),
        formMethod: "POST",
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("skips revalidation when only the package selection changes", () => {
    assert(
      !shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?packageTab=files&packagePath=%2Fpackage%2F1.0.0%2F",
        ),
        nextUrl: new URL("https://example.test/marketplace/example?packageTab=workflows"),
        defaultShouldRevalidate: true,
      } as never),
    );
  });
});

function renderMarketplaceDetail(
  selectedVersion: string,
  actionData?: IngestionActionDataFixture,
  versionHistory = [{ version: "2.0.0", publishedAt: "2026-01-01T00:00:00.000Z" }],
  tab: "overview" | "install" = actionData ? "install" : "overview",
  installation: (MarketplaceInstallationReference & { workflowInstanceId: string }) | null = null,
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
    installationReference: installation,
    nextVersionCursor: undefined,
    hasNextVersionPage: false,
    manageOrganizationId: null,
    installationCollectionSource: {
      resolvedScope: {
        kind: "org",
        organization: { id: "org-1", slug: "acme", jurisdiction: null },
      },
      adapterIdentity: "automations-test-adapter",
    },
    installationSetup: {
      state: "ready",
      setup: { permissions: [], agents: [], routes: [], eventTypes: [] },
    },
    packageFiles: {
      state: "ready",
      fileTree: { entries: [] },
      selectedVersion,
    },
  };
  const router = createMemoryRouter(
    [
      {
        element: createElement(Outlet, {
          context: {
            selectedScope: {
              kind: "org",
              organization: { id: "org-1", slug: "ada-labs", jurisdiction: null },
              label: "Ada Labs",
            },
          },
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
      initialEntries: [`/marketplace?packageVersion=${selectedVersion}&packageTab=${tab}`],
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

    assert(result instanceof Response);
    assert(result.status === 302);
    const destination = new URL(result.headers.get("Location")!, "https://example.test");
    expect(readMarketplaceInstallationReference(destination.search)).toEqual({
      organizationId: "org-1",
      version: "1.0.0",
      installationRoot: "/workspace/telegram-test-command",
    });
    assert(destination.searchParams.get("packageTab") === "install");
    expect(automationsForMock).toHaveBeenCalledWith({
      kind: "org",
      orgId: "org-1",
      jurisdiction: null,
    });
    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      {
        marketplace: { kind: "system" },
        listingId,
        targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
        installationRoot: "/workspace/telegram-test-command",
        version: "1.0.0",
        permissions: [],
      },
      expect.objectContaining({ propagationContext: null }),
    );
  });

  test("persists the exact release, canonical folder, and personal coordinator after starting", async () => {
    restartMarketplaceIngestionMock.mockResolvedValueOnce({
      listingId,
      version: "1.3.0",
      workflowInstanceId: "marketplace-package-install-1",
      action: "created",
      workflowStatus: "active",
    });
    const result = await runAction({
      scope: { kind: "user", userId: "user-1", jurisdiction: null },
      version: "1.3.0",
      extraFormEntries: { installationRoot: " /workspace/custom-telegram/ " },
    });
    assert(result instanceof Response);
    const destination = new URL(result.headers.get("Location")!, "https://example.test");
    const reference = readMarketplaceInstallationReference(destination.search);
    expect(reference).toEqual(installationReference);
    assert(destination.searchParams.get("packageVersion") === "1.3.0");
    assert(reference);
    const reloaded = await runLoader(
      { kind: "user", userId: "user-1", jurisdiction: null },
      reference.version,
      reference,
    );
    assert(!(reloaded instanceof Response));
    expect(reloaded.installationReference).toMatchObject(installationReference);
  });

  test("ignores forged destination fields and trusts the selected route scope", async () => {
    await runAction({
      version: "1.0.0",
      extraFormEntries: {
        organizationId: "org-other",
        targetScope: backofficeScopePathSegment({
          kind: "user",
          userId: "user-2",
          jurisdiction: null,
        }),
      },
    });

    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      }),
      expect.anything(),
    );
  });

  test("starts ingestion into the project selected in the route", async () => {
    const targetScope = {
      kind: "project",
      owner: { kind: "org", orgId: "org-1", jurisdiction: null },
      projectId: "project-1",
    } as const;

    await runAction({ scope: targetScope, version: "1.0.0" });

    expect(automationsForMock).toHaveBeenCalledWith({
      kind: "org",
      orgId: "org-1",
      jurisdiction: null,
    });
    expect(restartMarketplaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetScope }),
      expect.anything(),
    );
  });

  test("restarts the entire deterministic ingestion workflow", async () => {
    restartMarketplaceIngestionMock.mockResolvedValueOnce({
      listingId,
      version: "1.0.0",
      workflowInstanceId: "marketplace-package-install-1",
      action: "restarted",
      workflowStatus: "active",
    });

    const result = await runAction({ version: "1.0.0" });

    assert(result instanceof Response);
    expect(
      readMarketplaceInstallationReference(
        new URL(result.headers.get("Location")!, "https://example.test").search,
      ),
    ).toEqual({
      organizationId: "org-1",
      version: "1.0.0",
      installationRoot: "/workspace/telegram-test-command",
    });
  });

  test("surfaces owning service failures", async () => {
    restartMarketplaceIngestionMock.mockRejectedValueOnce(new Error("Workspace file conflict."));

    const result = await runAction({ version: "1.0.0" });

    expect(result).toEqual({ ok: false, message: "Workspace file conflict." });
  });

  test("rejects another user's personal scope", async () => {
    const result = await runAction({
      scope: { kind: "user", userId: "user-2", jurisdiction: null },
    });

    expect(result).toEqual({
      ok: false,
      message: "You can only install into your personal workspace.",
    });
    expect(restartMarketplaceIngestionMock).not.toHaveBeenCalled();
  });
});
