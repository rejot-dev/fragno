import { assert, describe, expect, test } from "vitest";

import { RouterContextProvider } from "react-router";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";

import { loader } from "./mine";

const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
};

function runLoader(url: URL) {
  const context = new RouterContextProvider();
  provideBackofficeShellRequest(context, {
    me: authenticatedUser as unknown as BackofficeMeData,
    routeScope: null,
  });
  return loader({ request: new Request(url), context, url } as never);
}

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
