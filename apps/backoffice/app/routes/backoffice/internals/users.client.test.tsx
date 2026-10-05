// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { updateUserRole } = vi.hoisted(() => ({ updateUserRole: vi.fn() }));
vi.mock("@/fragno/auth/auth-client", () => ({
  authClient: { useUpdateUserRole: () => ({ mutate: updateUserRole }) },
}));
import BackofficeInternalUsers from "./users";

const initialPage = {
  users: [
    {
      id: "user-1",
      email: "one@example.com",
      role: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  search: "",
  page: 1,
  total: 2,
  totalPages: 2,
};
const finalPage = {
  users: [
    {
      id: "user-2",
      email: "two@example.com",
      role: "admin" as const,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  search: "",
  page: 2,
  total: 2,
  totalPages: 2,
};
const routers: ReturnType<typeof createMemoryRouter>[] = [];
afterEach(() => {
  cleanup();
  updateUserRole.mockReset();
  for (const router of routers.splice(0)) {
    router.dispose();
  }
});

function renderUsers(currentUserId = "current-user", combinePages = false) {
  const router = createMemoryRouter([
    {
      element: (
        <Outlet
          context={{
            me: { user: { id: currentUserId } },
            selectedRouteScope: { kind: "org", orgSlug: "acme" },
          }}
        />
      ),
      children: [
        {
          path: "/",
          Component: BackofficeInternalUsers,
          loader: ({ request }) =>
            combinePages
              ? { ...initialPage, users: [...initialPage.users, ...finalPage.users], totalPages: 1 }
              : new URL(request.url).searchParams.get("page") === "2"
                ? finalPage
                : initialPage,
        },
      ],
    },
  ]);
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}

describe("Backoffice internal users", () => {
  test("moves between traditional result pages", async () => {
    const router = renderUsers();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("two@example.com")).toBeTruthy();
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    assert(new URLSearchParams(router.state.location.search).get("page") === "2");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("one@example.com")).toBeTruthy();
  });
  test("keeps the success notice after updating a user's role", async () => {
    updateUserRole.mockResolvedValue(undefined);
    renderUsers();
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Global role for one@example.com" }),
      { target: { value: "admin" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText("Role updated.")).toBeTruthy();
    expect(updateUserRole).toHaveBeenCalledWith({
      path: { userId: "user-1" },
      body: { role: "admin" },
    });
  });
  test("does not allow the current user to change their own global role", async () => {
    renderUsers("user-1", true);
    const ownRole = await screen.findByRole("combobox", {
      name: "Global role for one@example.com",
    });
    const otherRole = screen.getByRole("combobox", { name: "Global role for two@example.com" });
    assert(ownRole.hasAttribute("disabled"));
    assert(!otherRole.hasAttribute("disabled"));
    expect(screen.getByText("You cannot change your own role.")).toBeTruthy();
  });
});
