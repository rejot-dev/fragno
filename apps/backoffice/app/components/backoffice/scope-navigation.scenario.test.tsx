// @vitest-environment happy-dom

import { afterEach, assert, describe, expect, test } from "vitest";

import { useState } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { resolveBackofficePageScope } from "@/layouts/backoffice-layout-scope";

import { BackofficePhoneChrome } from "./phone-chrome";
import { BackofficeProjectMenu } from "./project-menu";
import { BackofficeMobileNav, BackofficeSidebarNav, useBackofficeSections } from "./sidebar-nav";

const organization: Organization = {
  id: "agency-id",
  slug: "agency",
  name: "Agency",
  createdBy: "ada",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  jurisdiction: null,
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
    jurisdiction: null,
    onboardedAt: new Date("2026-01-01T00:00:00.000Z"),
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
    findUser: async (userId) => ({ userId, jurisdiction: null }),
    isAppInstalled: async (_owner, appId) => appId === "bookkeeping",
    findProject: async (_owner, slug) => projects.find((project) => project.slug === slug) ?? null,
  });
  assert(result.status === "resolved");
  return result.scope;
}

type Navigation = "desktop" | "mobile" | "phone";

function NavigationScenario({ navigation }: { navigation: Navigation }) {
  const scope = useLoaderData<typeof loadScope>();
  const [collapsed, setCollapsed] = useState(false);
  const sections = useBackofficeSections(scope, me);
  const routeScope = backofficeRouteScopeFromResolvedScope(scope);
  const owner = routeScope.kind === "project" ? routeScope.owner : routeScope;
  return (
    <>
      {navigation === "desktop" ? (
        <BackofficeSidebarNav
          sections={sections}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
      ) : navigation === "mobile" ? (
        <BackofficeMobileNav sections={sections} />
      ) : (
        <BackofficePhoneChrome
          sections={sections}
          me={me}
          resolvedScope={scope}
          administeredMember={null}
          projectList={null}
          isLoading={false}
        />
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

async function renderNavigation(initialPath: string, navigation: Navigation) {
  const router = createMemoryRouter(
    [
      ...["/backoffice/organizations/:orgSlug/*", "/backoffice/:section/:scopeKind/:scopeId/*"].map(
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

// Phones list Settings in the menu that More opens, rather than in the tab bar.
async function querySettingsLink(navigation: Navigation): Promise<HTMLElement | null> {
  if (navigation === "phone") {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("dialog", { name: "Menu" });
  }
  return screen.queryByRole("link", { name: "Settings" });
}

function personalScopes(userId: string): BackofficeRouteScope[] {
  const owner = { kind: "user" as const, userId, jurisdiction: null };
  const app = { kind: "app" as const, owner, appId: "bookkeeping" };
  return [
    owner,
    { kind: "project", owner, projectSlug: "books" },
    app,
    { kind: "project", owner: app, projectSlug: "books" },
  ];
}

describe("scope navigation scenarios", () => {
  test.each(["desktop", "mobile", "phone"] as const)(
    "%s navigation reaches personal settings from owned descendants but not another member's",
    async (navigation) => {
      const router = await renderNavigation("/backoffice/dashboard/user/ada", navigation);
      await screen.findByRole("navigation", { name: "Backoffice" });

      for (const scope of personalScopes("ada")) {
        await act(() =>
          router.navigate(`/backoffice/dashboard/${backofficeRouteScopePath(scope)}`),
        );
        const settings = await querySettingsLink(navigation);
        assert(settings?.getAttribute("href") === "/backoffice/settings");
        fireEvent.click(settings);
        await screen.findByRole("heading", { name: "Personal settings" });
        assert(router.state.location.pathname === "/backoffice/settings");
      }

      for (const scope of personalScopes("cleo")) {
        await act(() =>
          router.navigate(`/backoffice/dashboard/${backofficeRouteScopePath(scope)}`),
        );
        expect(screen.getByRole("navigation", { name: "Backoffice" })).toBeTruthy();
        expect(await querySettingsLink(navigation)).toBeNull();
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
        // Settings returns to the tab it was left on.
        assert(
          screen.getByRole("link", { name: "Settings" }).getAttribute("href") === settingsPath,
        );
        await act(() => router.navigate(settingsPath));
        await screen.findByRole("button", { name: "Switch project. Current project: none" });
      }
    },
  );

  test.each(["desktop", "mobile", "phone"] as const)(
    "%s navigation returns to where each section was left, per scope",
    async (navigation) => {
      const router = await renderNavigation("/backoffice/dashboard/user/ada", navigation);
      const tab = (name: string) =>
        within(screen.getByRole("navigation", { name: "Backoffice" })).getByRole("link", { name });
      const follow = async (name: string) => {
        await act(async () => {
          fireEvent.click(tab(name));
        });
      };
      const pathname = () => router.state.location.pathname;
      // Phones start Agents in the assistant's conversation; wider screens in the list of agents.
      const agentsStart = (scopePath: string) =>
        `/backoffice/agents/${scopePath}/agents${navigation === "phone" ? "/assistant" : ""}`;

      await act(() => router.navigate("/backoffice/agents/user/ada/agents/researcher"));
      await follow("Files");
      assert(pathname() === "/backoffice/files/user/ada");
      await act(() => router.navigate("/backoffice/files/user/ada?path=uploads"));

      await follow("Agents");
      assert(pathname() === "/backoffice/agents/user/ada/agents/researcher");
      assert(tab("Files").getAttribute("href") === "/backoffice/files/user/ada?path=uploads");

      // The current section's link starts it over.
      await follow("Agents");
      assert(pathname() === agentsStart("user/ada"));

      await act(() => router.navigate("/backoffice/dashboard/org/agency"));
      assert(tab("Agents").getAttribute("href") === agentsStart("org/agency"));
    },
  );
});
