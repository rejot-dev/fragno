// @vitest-environment happy-dom

import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { MemoryRouter, Outlet, Route, Routes } from "react-router";

import { cleanup, render, screen } from "@testing-library/react";

const { useOrganizationMembers } = vi.hoisted(() => ({
  useOrganizationMembers: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-client", () => ({
  authClient: {
    useOrganizationMembers,
    useUpdateOrganizationMemberRoles: () => ({ mutate: vi.fn() }),
    useRemoveOrganizationMember: () => ({ mutate: vi.fn() }),
  },
}));

import BackofficeOrganizationMembers from "./organization-members";

afterEach(() => {
  cleanup();
  useOrganizationMembers.mockReset();
});

function renderMembers() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                organization: { id: "organization-1" },
                member: { roles: ["owner"] },
                me: { user: { id: "xPJUkt7ICr36M63V1TAhA16t33WmMkoY", role: "user" } },
              }}
            />
          }
        >
          <Route index element={<BackofficeOrganizationMembers />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Backoffice organization members", () => {
  test("shows member names and email addresses instead of user IDs", async () => {
    useOrganizationMembers.mockReturnValue({
      data: {
        members: [
          {
            id: "member-1",
            organizationId: "organization-1",
            userId: "xPJUkt7ICr36M63V1TAhA16t33WmMkoY",
            roles: ["owner"],
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            updatedAt: new Date("2026-08-20T12:00:00.000Z"),
            user: {
              name: "Alice Example",
              email: "alice@example.com",
              imageUrl: null,
            },
          },
        ],
        page: 1,
        total: 1,
        totalPages: 1,
      },
      loading: false,
      error: null,
    });

    renderMembers();

    const memberName = await screen.findByText("Alice Example");
    const ownMemberLabel = screen.getByText("You");

    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.queryByText("xPJUkt7ICr36M63V1TAhA16t33WmMkoY")).toBeNull();
    expect(memberName.parentElement).toBe(ownMemberLabel.parentElement);
    assert(screen.getByRole("button", { name: "owner" }).hasAttribute("disabled"));
    assert(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"));
    assert(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"));
  });
});
