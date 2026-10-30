import { beforeEach, describe, expect, test, vi } from "vitest";
// @vitest-environment happy-dom

import type { ReactNode } from "react";

import { render } from "@testing-library/react";

import type { Organization } from "@/fragno/auth/contracts";

const { sectionsMock, terminalMock, topBarMock } = vi.hoisted(() => ({
  sectionsMock: vi.fn(),
  terminalMock: vi.fn(),
  topBarMock: vi.fn(),
}));

vi.mock("@/fragno/auth/browser-auth.client", () => ({
  scheduleBackofficeTokenRefresh: () => () => undefined,
}));
vi.mock("./cls-debugger", () => ({ BackofficeClsDebugger: () => null }));
vi.mock("./global-hotkeys", () => ({
  GlobalHotkeysProvider: ({ children }: { children: ReactNode }) => children,
  useGlobalHotkey: () => undefined,
}));
vi.mock("./agent-drawer", () => ({ AGENT_DRAWER_ID: "agent-drawer", AgentDrawer: () => null }));
vi.mock("./quake-terminal", () => ({
  QuakeTerminal: (props: unknown) => {
    terminalMock(props);
    return null;
  },
}));
vi.mock("./sidebar-nav", () => ({
  BackofficeSidebarNav: () => null,
  useBackofficeSections: (...args: unknown[]) => {
    sectionsMock(...args);
    return { primary: [], context: [], phone: { tabs: [], all: [] } };
  },
}));
vi.mock("./phone-chrome", () => ({ BackofficePhoneChrome: () => null }));
vi.mock("./top-bar", () => ({
  BackofficeTopBar: (props: unknown) => {
    topBarMock(props);
    return null;
  },
}));

import { BackofficeShell } from "./shell";

const organization: Organization = {
  id: "org-1",
  slug: "acme",
  name: "Acme",
  createdBy: "user-1",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  jurisdiction: null,
};

describe("BackofficeShell resolved scope", () => {
  beforeEach(() => {
    sectionsMock.mockClear();
    terminalMock.mockClear();
    topBarMock.mockClear();
  });

  test("keeps shell navigation scoped when Automations synchronization is unavailable", async () => {
    const resolvedScope = {
      kind: "project" as const,
      owner: { kind: "org" as const, organization },
      project: { id: "project-1", slug: "project-1", name: "Project One" },
    };

    render(
      <BackofficeShell
        me={null}
        resolvedScope={resolvedScope}
        administeredMember={null}
        accessTokenExpiresAt={null}
        automationReplicaSource={{
          status: "unavailable",
          resolvedScope,
          message: "Workflow synchronization is unavailable.",
        }}
        projectList={null}
      >
        <div>Backoffice</div>
      </BackofficeShell>,
    );

    expect(topBarMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedScope }));
    expect(sectionsMock).toHaveBeenCalledWith(resolvedScope, null);
    // The terminal is imported once the shell has mounted.
    await vi.waitFor(() => {
      expect(terminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pageScope: {
            ...resolvedScope,
            label: "Acme / Project One",
          },
        }),
      );
    });
  });
});
