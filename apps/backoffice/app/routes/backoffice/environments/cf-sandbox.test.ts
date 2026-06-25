import { describe, expect, test, vi, assert } from "vitest";

const { getAuthMeMock, getSandboxRuntimeMock } = vi.hoisted(() => ({
  getAuthMeMock: vi.fn(),
  getSandboxRuntimeMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({
  getAuthMe: getAuthMeMock,
}));

vi.mock("@/worker-runtime/sandbox-manager", () => ({
  getSandboxRuntime: getSandboxRuntimeMock,
}));

import { action } from "./cf-sandbox";
import { toCfSandboxPath } from "./cf-sandbox-path";

describe("CF Sandbox path builder", () => {
  test("builds sandbox links without an explicit organization scope", () => {
    assert(toCfSandboxPath({}) === "/backoffice/environments/cf-sandbox");
    assert(toCfSandboxPath({ view: "new" }) === "/backoffice/environments/cf-sandbox?view=new");
    assert(
      toCfSandboxPath({ view: "detail", sandboxId: "sandbox-1" }) ===
        "/backoffice/environments/cf-sandbox?sandbox=sandbox-1",
    );
  });
});

describe("CF Sandbox action", () => {
  test("starts a sandbox without bootstrapping files", async () => {
    getAuthMeMock.mockResolvedValue({
      activeOrganization: { organization: { id: "org_123" } },
    });

    const sandboxRuntime = {
      startSandbox: vi.fn(async () => ({ id: "sandbox-1", status: "running" as const })),
      executeCommand: vi.fn(),
      killSandbox: vi.fn(),
      listSandboxes: vi.fn(),
    };
    getSandboxRuntimeMock.mockReturnValue(sandboxRuntime);

    const formData = new FormData();
    formData.set("intent", "start");
    formData.set("id", "sandbox-1");

    const response = await action({
      request: new Request("https://docs.example.test/backoffice/environments/cf-sandbox", {
        method: "POST",
        body: formData,
      }),
      context: {},
      params: {},
    } as never);

    expect(sandboxRuntime.startSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-1", startupCommand: "true" }),
    );
    expect(sandboxRuntime.executeCommand).not.toHaveBeenCalled();
    expect(response).toBeInstanceOf(Response);
    assert(
      (response as Response).headers.get("Location") ===
        "/backoffice/environments/cf-sandbox?sandbox=sandbox-1",
    );
  });
});
