// @vitest-environment happy-dom

import { afterEach, assert, describe, expect, test } from "vitest";

import { useState } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { resolveBackofficePageScope } from "@/layouts/backoffice-layout-scope";

import { BackofficeProjectMenu } from "./project-menu";
import { BackofficeMobileNav, BackofficeSidebarNav } from "./sidebar-nav";

const organization: Organization = {
  id: "agency-id",
  slug: "agency",
  name: "Agency",
  createdBy: "ada",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};
const me: BackofficeMeData = {
  user: {
    id: "ada",
    name: "Ada",
    email: "ada@example.com",
    emailVerified: true,
    role: "user",
    banned: false,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
  organizations: [{ organization, roles: ["owner"], through: { kind: "membership" } }],
  activeOrganizationId: null,
  activeOrganization: null,
};
const projects = [
  { id: "books-id", slug: "books", name: "Books" },
  { id: "sales-id", slug: "sales", name: "Sales" },
];
const routers: ReturnType<typeof createMemoryRouter>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const router of routers.splice(0)) {
      router.dispose();
    }
  });
});

async function loadScope({ params }: LoaderFunctionArgs) {
  const result = await resolveBackofficePageScope<Organization, (typeof projects)[number]>({
    params,
    organizations: [organization],
    isAppInstalled: async (_owner, appId) => appId === "bookkeeping",
    findProject: async (_owner, slug) => projects.find((project) => project.slug === slug) ?? null,
  });
  assert(result.status === "resolved");
  return result.scope;
}

function NavigationScenario({ navigation }: { navigation: "desktop" | "mobile" }) {
  const scope = useLoaderData<typeof loadScope>();
  const [collapsed, setCollapsed] = useState(false);
  const routeScope = backofficeRouteScopeFromResolvedScope(scope);
  const owner = routeScope.kind === "project" ? routeScope.owner : routeScope;
  return (
    <>
      {navigation === "desktop" ? (
        <BackofficeSidebarNav
          currentScope={scope}
          me={me}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
      ) : (
        <BackofficeMobileNav currentScope={scope} me={me} />
      )}
      {owner.kind !== "system" ? (
        <BackofficeProjectMenu
          owner={owner}
          administeredMember={null}
          currentProject={
            scope.kind === "project"
              ? { slug: scope.project.slug, label: scope.project.name }
              : null
          }
          projects={projects.map((project) => ({ slug: project.slug, label: project.name }))}
          projectsError={null}
          projectsLoading={false}
        />
      ) : null}
    </>
  );
}

async function renderNavigation(initialPath: string, navigation: "desktop" | "mobile") {
  const router = createMemoryRouter(
    [
      ...["/backoffice/organizations/:orgSlug/*", "/backoffice/dashboard/:scopeKind/:scopeId"].map(
        (path) => ({
          path,
          loader: loadScope,
          element: <NavigationScenario navigation={navigation} />,
          hydrateFallbackElement: <p>Loading scope</p>,
        }),
      ),
      { path: "/backoffice/settings", element: <h1>Personal settings</h1> },
    ],
    { initialEntries: [initialPath] },
  );
  routers.push(router);
  // A visible trigger can precede the async route's interaction setup.
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

function personalScopes(userId: string): BackofficeRouteScope[] {
  const owner = { kind: "user" as const, userId };
  const app = { kind: "app" as const, owner, appId: "bookkeeping" };
  return [
    owner,
    { kind: "project", owner, projectSlug: "books" },
    app,
    { kind: "project", owner: app, projectSlug: "books" },
  ];
}

describe("scope navigation scenarios", () => {
  test.each(["desktop", "mobile"] as const)(
    "%s navigation reaches personal settings from owned descendants but not another member's",
    async (navigation) => {
      const router = await renderNavigation("/backoffice/dashboard/user/ada", navigation);
      await screen.findByRole("navigation", { name: "Backoffice" });

      for (const scope of personalScopes("ada")) {
        await act(() =>
          router.navigate(`/backoffice/dashboard/${backofficeRouteScopePath(scope)}`),
        );
        const settings = screen.getByRole("link", { name: "Settings" });
        assert(settings.getAttribute("href") === "/backoffice/settings");
        fireEvent.click(settings);
        await screen.findByRole("heading", { name: "Personal settings" });
        assert(router.state.location.pathname === "/backoffice/settings");
      }

      for (const scope of personalScopes("cleo")) {
        await act(() =>
          router.navigate(`/backoffice/dashboard/${backofficeRouteScopePath(scope)}`),
        );
        expect(screen.getByRole("navigation", { name: "Backoffice" })).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
      }
    },
  );

  test.each(["", "/members", "/clients", "/invites", "/billing"])(
    "selecting projects from organization settings%s enters each selected project",
    async (tab) => {
      const settingsPath = `/backoffice/organizations/agency${tab}`;
      const router = await renderNavigation(settingsPath, "desktop");
      await screen.findByRole("button", { name: "Switch project. Current project: none" });

      for (const project of projects) {
        const trigger = screen.getByRole("button", { name: /Switch project/ });
        await act(async () => {
          trigger.focus();
          fireEvent.keyDown(trigger, { key: "ArrowDown" });
          fireEvent.keyUp(trigger, { key: "ArrowDown" });
        });
        const option = await screen.findByRole("menuitem", { name: new RegExp(project.name) });
        await act(async () => {
          fireEvent.click(option);
        });
        await waitFor(() => {
          expect(router.state.location.pathname).toBe(
            `/backoffice/dashboard/project/org:agency:${project.slug}`,
          );
          expect(
            screen.getByRole("button", {
              name: `Switch project. Current project: ${project.name}`,
            }),
          ).toBeTruthy();
        });
        assert(
          screen.getByRole("link", { name: "Settings" }).getAttribute("href") ===
            "/backoffice/organizations/agency",
        );
        await act(() => router.navigate(settingsPath));
        await screen.findByRole("button", { name: "Switch project. Current project: none" });
      }
    },
  );
});
