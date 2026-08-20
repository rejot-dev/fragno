// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

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
  page: 2,
  total: 2,
  totalPages: 2,
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
  test("moves between traditional result pages", async () => {
    useUsers.mockImplementation(({ query }: { query: { page: string } }) => ({
      data: query.page === "1" ? initialPage : finalPage,
      loading: false,
      error: undefined,
    }));

    renderUsers();

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("two@example.com")).toBeTruthy();
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(useUsers).toHaveBeenCalledWith({
      query: {
        search: undefined,
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: "50",
        page: "2",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("one@example.com")).toBeTruthy();
  });

  test("keeps the success notice after updating a user's role", async () => {
    updateUserRole.mockResolvedValue(undefined);
    useUsers.mockReturnValue({
      data: initialPage,
      loading: false,
      error: undefined,
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
        users: [...initialPage.users, ...finalPage.users],
        page: 1,
        total: 2,
        totalPages: 1,
      },
      loading: false,
      error: undefined,
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
