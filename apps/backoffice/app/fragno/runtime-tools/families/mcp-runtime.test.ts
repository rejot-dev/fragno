import { assert, describe, test } from "vitest";

import { createRouteBackedMcpRuntime } from "./mcp-runtime";

const publicAddress = {
  baseUrl: "https://backoffice.example/api/mcp/org%3Aacme",
  oauthRedirectUri: "https://backoffice.example/api/mcp/org%3Aacme/oauth/callback",
};

describe("route-backed MCP runtime public addresses", () => {
  test("supplies the canonical redirect URI when OAuth starts", async () => {
    const requests: Request[] = [];
    const runtime = createRouteBackedMcpRuntime({
      baseUrl: "https://mcp.do",
      resolvePublicAddress: async () => publicAddress,
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          authorizationUrl: "https://provider.example/authorize",
          state: "state-1",
        });
      },
    });

    await runtime.startOAuth({ slug: "github", scope: "tools" });

    const request = requests[0];
    assert(request);
    assert.equal(
      new URL(request.url).searchParams.get("redirectUri"),
      publicAddress.oauthRedirectUri,
    );
    assert.deepEqual(await request.json(), { scope: "tools" });
  });
});
