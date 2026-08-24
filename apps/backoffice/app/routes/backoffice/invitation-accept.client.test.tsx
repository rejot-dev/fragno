// @vitest-environment happy-dom

import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

import { MemoryRouter, Route, Routes } from "react-router";

import { act, cleanup, render, screen } from "@testing-library/react";

const { respondInvitation, useUserInvitations } = vi.hoisted(() => ({
  respondInvitation: vi.fn(),
  useUserInvitations: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-client", () => ({
  authClient: {
    useRespondOrganizationInvitation: () => ({
      mutate: respondInvitation,
      loading: false,
    }),
    useUserInvitations,
  },
}));

import BackofficeInvitationAccept from "./invitation-accept";

const invitationId = "invitation-1";
const invitationToken = "invitation-token";

beforeEach(() => {
  useUserInvitations.mockReturnValue({
    data: {
      invitations: [
        {
          invitation: {
            id: invitationId,
            organizationId: "organization-1",
            email: "member@example.com",
            roles: ["member"],
            status: "pending",
            inviterId: "owner-1",
            expiresAt: new Date("2026-08-21T12:00:00.000Z"),
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            token: invitationToken,
          },
          organization: {
            id: "organization-1",
            slug: "example-organization",
            name: "Example Organization",
          },
        },
      ],
    },
    loading: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  respondInvitation.mockReset();
  useUserInvitations.mockReset();
});

function renderInvitation() {
  return render(
    <MemoryRouter
      initialEntries={[
        `/backoffice/invitations/${invitationId}?token=${encodeURIComponent(invitationToken)}`,
      ]}
    >
      <Routes>
        <Route
          path="/backoffice/invitations/:invitationId"
          element={<BackofficeInvitationAccept />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Backoffice invitation acceptance", () => {
  test("shows success after the acceptance request completes", async () => {
    let resolveAcceptance: ((value: unknown) => void) | null = null;
    respondInvitation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAcceptance = resolve;
        }),
    );

    renderInvitation();

    expect(await screen.findByText("Accepting invitation...")).toBeTruthy();
    await act(async () => {
      resolveAcceptance?.({ invitation: { organizationId: "organization-1" } });
      await Promise.resolve();
    });

    expect(await screen.findByText("Invitation accepted.")).toBeTruthy();
    expect(screen.queryByText("Accepting invitation...")).toBeNull();
    const organizationLink = screen.getByRole("link", { name: "Open organization" });
    const destination = new URL(organizationLink.getAttribute("href") ?? "", "https://example.com");
    assert(destination.searchParams.get("organizationId") === "organization-1");
    assert(
      destination.searchParams.get("returnTo") === "/backoffice/organizations/example-organization",
    );
    expect(respondInvitation).toHaveBeenCalledTimes(1);
  });
});
