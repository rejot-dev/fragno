import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ReactNode } from "react";
// @vitest-environment happy-dom

import { render } from "@testing-library/react";

const backofficeShellMock = vi.hoisted(() => vi.fn());

vi.mock("@fragno-private/design-system/page-header", () => ({
  BackofficePageHeader: () => null,
}));

vi.mock("@/components/backoffice/shell", () => ({
  BackofficeShell: (props: { children: ReactNode }) => {
    backofficeShellMock(props);
    return props.children;
  },
}));

import type { AuthUser } from "@/fragno/auth/contracts";

import BackofficeLayout from "./backoffice-layout-ui";

const user: AuthUser = {
  id: "user-current",
  email: "current@example.test",
  name: "Current User",
  emailVerified: true,
  role: "user",
  banned: false,
  createdAt: new Date("2026-08-24T12:00:00.000Z"),
  updatedAt: new Date("2026-08-24T12:00:00.000Z"),
  jurisdiction: null,
  onboardedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("Backoffice layout organization preference", () => {
  beforeEach(() => {
    backofficeShellMock.mockClear();
  });

  test("passes resolved scope independently from unavailable Automations synchronization", () => {
    const resolvedScope = {
      kind: "project" as const,
      organization: { id: "org-current", slug: "current-org", name: "Current Org" },
      projectId: "project-1",
    };
    const automationReplicaSource = {
      status: "unavailable" as const,
      resolvedScope,
      message: "Workflow synchronization is unavailable.",
    };

    render(
      <BackofficeLayout
        loaderData={
          {
            me: { activeOrganizationId: "org-current", user },
            accessTokenExpiresAt: "2026-09-01T12:15:00.000Z",
            resolvedScope,
            automationReplicaSource,
            projectList: null,
          } as never
        }
      >
        <div>Backoffice</div>
      </BackofficeLayout>,
    );

    expect(backofficeShellMock).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedScope, automationReplicaSource }),
    );
  });
});
