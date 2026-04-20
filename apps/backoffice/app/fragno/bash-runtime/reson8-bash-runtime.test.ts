import { describe, expect, it } from "vitest";

import { NotConfiguredError, createRouteBackedReson8Runtime } from "./reson8-bash-runtime";

describe("reson8 route-backed runtime", () => {
  it("sends prerecorded audio and returns the JSON transcription", async () => {
    const requests: Array<{ method: string; path: string; contentType: string | null }> = [];
    const runtime = createRouteBackedReson8Runtime({
      baseUrl: "https://reson8.do",
      fetch: async (request) => {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          contentType: request.headers.get("content-type"),
        });

        return Response.json({
          text: "hello world",
          language: "en",
          duration: 1.2,
          segments: [],
        });
      },
    });

    const result = await runtime.transcribePrerecorded({
      audio: new Uint8Array([1, 2, 3]),
      query: { include_words: "true" },
    });

    expect(result).toMatchObject({
      text: "hello world",
      language: "en",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/reson8/speech-to-text/prerecorded?include_words=true",
        contentType: "application/octet-stream",
      },
    ]);
  });

  it("turns NOT_CONFIGURED route errors into the shared typed error", async () => {
    const runtime = createRouteBackedReson8Runtime({
      baseUrl: "https://reson8.do",
      fetch: async () => Response.json({ code: "NOT_CONFIGURED" }, { status: 400 }),
    });

    await expect(
      runtime.transcribePrerecorded({ audio: new Uint8Array([1, 2, 3]) }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "NotConfiguredError",
        message: "Reson8 is not configured for this organisation.",
      }),
    );
    await expect(
      runtime.transcribePrerecorded({ audio: new Uint8Array([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
