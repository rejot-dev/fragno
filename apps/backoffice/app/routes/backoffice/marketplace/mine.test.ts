import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock } = vi.hoisted(() => ({ findBackofficeMeMock: vi.fn() }));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import { loader } from "./mine";

const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
};

const runLoader = (url: URL) =>
  loader({
    request: new Request(url),
    context: {},
    url,
  } as never);

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
});

describe("My listings organization selection", () => {
  test("rejects a requested organization outside the authenticated memberships", async () => {
    const response = await runLoader(
      new URL("https://example.test/backoffice/marketplace/mine?organizationSlug=org-other"),
    ).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    assert((response as Response).status === 404);
    await expect((response as Response).text()).resolves.toBe(
      "Publisher organization was not found.",
    );
  });

  test("uses the active organization when no organization is requested", async () => {
    const response = await runLoader(new URL("https://example.test/backoffice/marketplace/mine"));

    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice/marketplace/org/ada-labs/my-listings");
  });
});
