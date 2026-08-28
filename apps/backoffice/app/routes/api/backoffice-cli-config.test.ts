import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { getAuthDurableObject, getBackofficeCliOAuthConfig } = vi.hoisted(() => ({
  getAuthDurableObject: vi.fn(),
  getBackofficeCliOAuthConfig: vi.fn(),
}));

vi.mock("@/worker-runtime/durable-objects", () => ({ getAuthDurableObject }));

import { loader } from "./backoffice-cli-config";

const context = {} as never;
const config = {
  clientId: "codemode-client",
  scope: "openid offline_access backoffice",
  deviceAuthorizationEndpoint: "https://backoffice.example/api/auth/device/code",
  tokenEndpoint: "https://backoffice.example/api/auth/oauth2/token",
  verificationUri: "https://backoffice.example/backoffice/device",
};

beforeEach(() => {
  getAuthDurableObject.mockReset();
  getBackofficeCliOAuthConfig.mockReset();
  getBackofficeCliOAuthConfig.mockResolvedValue(config);
  getAuthDurableObject.mockReturnValue({ commands: { getBackofficeCliOAuthConfig } });
});

describe("Backoffice CLI OAuth configuration route", () => {
  test("publishes the first-party client configuration without a session", async () => {
    const request = new Request("https://backoffice.example/api/backoffice/cli-config");

    const response = await loader({ request, context } as never);

    assert(response.status === 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    expect(await response.json()).toEqual(config);
    expect(getBackofficeCliOAuthConfig).toHaveBeenCalledWith({ requestUrl: request.url });
  });
});
