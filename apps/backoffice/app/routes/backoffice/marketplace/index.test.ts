import { assert, describe, test } from "vitest";

import { RouterContextProvider } from "react-router";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";

import { loader } from "./index";

const requestUrl = "https://example.test/backoffice/marketplace";

function runLoader(me: unknown) {
  const context = new RouterContextProvider();
  provideBackofficeShellRequest(context, { me: me as BackofficeMeData, routeScope: null });
  return loader({ request: new Request(requestUrl), context, url: new URL(requestUrl) } as never);
}

describe("Marketplace root scope selection", () => {
  test("redirects organization members to their active organization", async () => {
    const response = await runLoader({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
      activeOrganization: { organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } },
    });

    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice/marketplace/org/ada-labs/marketplace");
  });

  test("redirects organization-less users to their personal Marketplace", async () => {
    const response = await runLoader({
      user: { id: "user-1", email: "ada@example.com" },
      organizations: [],
      activeOrganization: null,
    });

    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice/marketplace/user/user-1/marketplace");
  });
});
