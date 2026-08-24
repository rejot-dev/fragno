import { beforeEach, describe, test, vi, assert } from "vitest";

import type { ReactNode } from "react";
// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/react";

vi.mock("@/components/backoffice", () => ({
  BackofficePageHeader: () => null,
  BackofficeShell: ({ children }: { children: ReactNode }) => children,
}));

import BackofficeLayout from "./backoffice-layout-ui";

describe("Backoffice layout organization preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("persists the organization selected by the issued Backoffice token", async () => {
    localStorage.setItem("fragno-backoffice-default-organization", "org-stale");

    render(
      <BackofficeLayout
        loaderData={
          {
            me: { activeOrganizationId: "org-current" },
            accessTokenExpiresAt: "2026-08-24T12:15:00.000Z",
            currentScope: { kind: "org", orgId: "org-current" },
            automationCollectionSource: { status: "ready", source: [] },
            projectCollectionSource: null,
          } as never
        }
      >
        <div>Backoffice</div>
      </BackofficeLayout>,
    );

    await waitFor(() => {
      assert(localStorage.getItem("fragno-backoffice-default-organization") === "org-current");
    });
  });
});
