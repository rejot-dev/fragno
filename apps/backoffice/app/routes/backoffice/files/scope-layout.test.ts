import { beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock, lookupAutomationProjectMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  lookupAutomationProjectMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));
vi.mock("../automations/data.server", () => ({
  lookupAutomationProject: lookupAutomationProjectMock,
}));

import { loader } from "./scope-layout";

describe("Files scope layout without an organization", () => {
  beforeEach(() => {
    findBackofficeMeMock.mockReset();
    lookupAutomationProjectMock.mockReset();
  });

  test("opens the personal workspace without loading projects", async () => {
    findBackofficeMeMock.mockResolvedValue(authMe({ role: "member" }));

    const result = await loader(
      loaderArgs("https://example.com/backoffice/files/user/user-1", {
        scopeKind: "user",
        scopeId: "user-1",
      }),
    );

    expect(lookupAutomationProjectMock).not.toHaveBeenCalled();
    expect(result.selectedScope).toEqual({
      kind: "user",
      userId: "user-1",
      label: "user@example.com",
    });
  });

  test("opens system files for an admin without loading projects", async () => {
    findBackofficeMeMock.mockResolvedValue(authMe({ role: "admin" }));

    const result = await loader(
      loaderArgs("https://example.com/backoffice/files/system/system", {
        scopeKind: "system",
        scopeId: "system",
      }),
    );

    expect(lookupAutomationProjectMock).not.toHaveBeenCalled();
    expect(result.selectedScope).toEqual({ kind: "system", label: "System" });
  });
});

const authMe = ({ role }: { role: string }) => ({
  user: { id: "user-1", email: "user@example.com", role },
  organizations: [],
  activeOrganization: null,
  invitations: [],
});

const loaderArgs = (url: string, params: { scopeKind: string; scopeId: string }) =>
  ({
    request: new Request(url),
    url: new URL(url),
    params,
    context: {} as never,
  }) as unknown as Parameters<typeof loader>[0];
