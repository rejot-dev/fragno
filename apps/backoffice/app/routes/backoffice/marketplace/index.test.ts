import { assert, beforeEach, describe, test, vi } from "vitest";

const { getAuthMeMock } = vi.hoisted(() => ({ getAuthMeMock: vi.fn() }));

vi.mock("@/fragno/auth/auth-server", () => ({ getAuthMe: getAuthMeMock }));

import { loader } from "./index";

const requestUrl = "https://example.test/backoffice/marketplace";

const runLoader = () =>
  loader({
    request: new Request(requestUrl),
    context: {},
    url: new URL(requestUrl),
  } as never);

beforeEach(() => {
  getAuthMeMock.mockReset();
});

describe("Marketplace root scope selection", () => {
  test("redirects organization members to their active organization", async () => {
    getAuthMeMock.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [{ organization: { id: "org-1", name: "Ada Labs" } }],
      activeOrganization: { organization: { id: "org-1", name: "Ada Labs" } },
    });

    const response = await runLoader();

    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice/marketplace/org/org-1/marketplace");
  });

  test("redirects organization-less users to their personal Marketplace", async () => {
    getAuthMeMock.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [],
      activeOrganization: null,
    });

    const response = await runLoader();

    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice/marketplace/user/user-1/marketplace");
  });
});
