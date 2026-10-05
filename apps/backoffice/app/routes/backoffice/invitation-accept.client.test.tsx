// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { createMemoryRouter, RouterProvider } from "react-router";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { respondInvitation } = vi.hoisted(() => ({ respondInvitation: vi.fn() }));
vi.mock("@/fragno/auth/auth-client", () => ({
  authClient: {
    useRespondOrganizationInvitation: () => ({ mutate: respondInvitation, loading: false }),
  },
}));
import BackofficeInvitationAccept from "./invitation-accept";

afterEach(() => {
  cleanup();
  respondInvitation.mockReset();
});

describe("Backoffice invitation acceptance", () => {
  test("requires confirmation and shows success after acceptance completes", async () => {
    let resolveAcceptance: ((value: unknown) => void) | null = null;
    respondInvitation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAcceptance = resolve;
        }),
    );
    const router = createMemoryRouter(
      [
        {
          path: "/backoffice/invitations/:invitationId",
          Component: BackofficeInvitationAccept,
          loader: () => ({
            invitation: { id: "invitation-1" },
            organization: {
              id: "organization-1",
              slug: "example-organization",
              name: "Example Organization",
            },
          }),
        },
      ],
      { initialEntries: ["/backoffice/invitations/invitation-1"] },
    );
    render(<RouterProvider router={router} />);
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    expect(respondInvitation).not.toHaveBeenCalled();
    fireEvent.click(accept);
    await act(async () => {
      resolveAcceptance?.({ invitation: { organizationId: "organization-1" } });
      await Promise.resolve();
    });
    expect(await screen.findByText("Invitation accepted.")).toBeTruthy();
    const destination = new URL(
      screen.getByRole("link", { name: "Open organization" }).getAttribute("href") ?? "",
      "https://example.com",
    );
    assert(destination.searchParams.get("organizationId") === "organization-1");
    assert(
      destination.searchParams.get("returnTo") === "/backoffice/organizations/example-organization",
    );
    expect(respondInvitation).toHaveBeenCalledTimes(1);
    router.dispose();
  });
});
