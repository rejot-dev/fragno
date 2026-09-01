import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import type { ReactNode } from "react";
// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/react";

const backofficeShellMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/backoffice", () => ({
  BackofficePageHeader: () => null,
  BackofficeShell: (props: { children: ReactNode }) => {
    backofficeShellMock(props);
    return props.children;
  },
}));

import BackofficeLayout from "./backoffice-layout-ui";

describe("Backoffice layout organization preference", () => {
  beforeEach(() => {
    localStorage.clear();
    backofficeShellMock.mockClear();
  });

  test("persists the organization selected by the issued Backoffice token", async () => {
    localStorage.setItem("fragno-backoffice-default-organization", "org-stale");

    render(
      <BackofficeLayout
        loaderData={
          {
            me: { activeOrganizationId: "org-current" },
            accessTokenExpiresAt: "2026-08-24T12:15:00.000Z",
            resolvedScope: {
              kind: "org",
              organization: { id: "org-current", slug: "current-org" },
            },
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

  test("passes resolved scope independently from unavailable Automations synchronization", () => {
    const resolvedScope = {
      kind: "project" as const,
      organization: { id: "org-current", slug: "current-org", name: "Current Org" },
      projectId: "project-1",
    };
    const automationCollectionSource = {
      status: "unavailable" as const,
      resolvedScope,
      message: "Workflow synchronization is unavailable.",
    };

    render(
      <BackofficeLayout
        loaderData={
          {
            me: { activeOrganizationId: "org-current" },
            accessTokenExpiresAt: "2026-09-01T12:15:00.000Z",
            resolvedScope,
            automationCollectionSource,
            projectCollectionSource: null,
          } as never
        }
      >
        <div>Backoffice</div>
      </BackofficeLayout>,
    );

    expect(backofficeShellMock).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedScope, automationCollectionSource }),
    );
  });
});
