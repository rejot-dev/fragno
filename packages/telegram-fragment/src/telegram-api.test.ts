import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramApi } from "./telegram-api";

describe("createTelegramApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves Telegram JSON error envelopes from non-success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error_code: 429, description: "Retry later" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const api = createTelegramApi({ botToken: "token", apiBaseUrl: "https://api.telegram.test" });
    const result = await api.call("sendMessage", {});

    expect(result).toEqual({ ok: false, errorCode: 429, description: "Retry later" });
  });

  it("reports HTTP status and body when an error response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" })),
    );

    const api = createTelegramApi({ botToken: "token", apiBaseUrl: "https://api.telegram.test" });
    const result = await api.call("sendMessage", {});

    expect(result).toEqual({
      ok: false,
      description: "Telegram API request failed (502 Bad Gateway): Bad gateway",
    });
  });
});
