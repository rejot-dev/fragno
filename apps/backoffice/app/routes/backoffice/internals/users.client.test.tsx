// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { updateUserRole, useUsers } = vi.hoisted(() => ({
  updateUserRole: vi.fn(),
  useUsers: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-client", () => ({
  authClient: {
    useUsers,
    useUpdateUserRole: () => ({ mutate: updateUserRole }),
  },
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
  cursor: "cursor-2",
  hasNextPage: true,
  sortBy: "createdAt" as const,
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
  cursor: undefined,
  hasNextPage: false,
  sortBy: "createdAt" as const,
};

afterEach(() => {
  cleanup();
  updateUserRole.mockReset();
  useUsers.mockReset();
});

const renderUsers = (currentUserId = "current-user") =>
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ me: { user: { id: currentUserId } } }} />}>
          <Route index element={<BackofficeInternalUsers />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe("Backoffice internal users", () => {
  test("retries a failed load-more request without losing the cursor", async () => {
    useUsers.mockImplementation(({ query }: { query: { cursor?: string } }) => {
      const [retryCount, setRetryCount] = useState(0);
      const refetch = () => {
        setRetryCount((currentCount) => currentCount + 1);
      };

      if (!query.cursor) {
        return { data: initialPage, loading: false, error: undefined, refetch };
      }

      return retryCount === 0
        ? { data: undefined, loading: false, error: new Error("Temporary failure"), refetch }
        : { data: finalPage, loading: false, error: undefined, refetch };
    });

    renderUsers();

    fireEvent.click(await screen.findByRole("button", { name: "Load more users" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Temporary failure");

    fireEvent.click(screen.getByRole("button", { name: "Load more users" }));

    expect(await screen.findByText("two@example.com")).toBeTruthy();
    expect(useUsers).toHaveBeenCalledWith({
      query: {
        search: undefined,
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: "50",
        cursor: "cursor-2",
      },
    });
  });

  test("keeps the success notice after updating a user's role", async () => {
    updateUserRole.mockResolvedValue(undefined);
    useUsers.mockReturnValue({
      data: initialPage,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

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
    useUsers.mockReturnValue({
      data: {
        ...initialPage,
        users: [...initialPage.users, ...finalPage.users],
        cursor: undefined,
        hasNextPage: false,
      },
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

    renderUsers("user-1");

    const ownRole = await screen.findByRole("combobox", {
      name: "Global role for one@example.com",
    });
    const otherRole = screen.getByRole("combobox", {
      name: "Global role for two@example.com",
    });

    assert(ownRole.hasAttribute("disabled"));
    assert(!otherRole.hasAttribute("disabled"));
    expect(screen.getByText("You cannot change your own role.")).toBeTruthy();
  });
});
