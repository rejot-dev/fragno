import { describe, expect, test, vi, assert } from "vitest";

import { createReson8Fragment, createReson8FragmentClients } from "./index";

describe("reson8-fragment exports", () => {
  test("creates client builders for the supported REST and realtime surface", () => {
    const clients = createReson8FragmentClients({ baseUrl: "https://example.com" });

    expect(Object.keys(clients).sort()).toEqual([
      "useAccessToken",
      "useCreateCustomModel",
      "useCustomModel",
      "useCustomModels",
      "useMicrophoneCapture",
      "usePrerecordedTranscription",
      "useRealtimeSession",
      "useRealtimeTranscriber",
      "useRequestToken",
    ]);

    assert(typeof clients.useCustomModels.query === "function");
    assert(typeof clients.useCustomModel.query === "function");
    assert(typeof clients.useRequestToken.mutateQuery === "function");
    assert(typeof clients.useCreateCustomModel.mutateQuery === "function");
    assert(typeof clients.usePrerecordedTranscription.mutateQuery === "function");
    expect(clients.useAccessToken).toBeDefined();
    expect(clients.useMicrophoneCapture).toBeDefined();
    expect(clients.useRealtimeSession).toBeDefined();
    expect(clients.useRealtimeTranscriber).toBeDefined();
  });

  test("creates a fragment instance without requiring database options", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "token_789",
          token_type: "Bearer",
          expires_in: 600,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const fragment = createReson8Fragment({
      apiKey: "test-api-key",
      fetch: fetchMock as typeof fetch,
    });

    const response = await fragment.callRoute("POST", "/auth/token");

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      access_token: "token_789",
      token_type: "Bearer",
      expires_in: 600,
    });
  });
});
