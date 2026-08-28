import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { NotConfiguredError } from "../runtime-errors";
import { createCloudflareRuntime } from "./cloudflare-runtime";

const createNotConfiguredHttp = () => ({
  fetch: async () =>
    Response.json(
      {
        code: "NOT_CONFIGURED",
        message: "Cloudflare credentials are missing.",
      },
      { status: 400 },
    ),
});

describe("createCloudflareRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bounds capture requests with an abort signal", async () => {
    const abortController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abortController.signal);
    let captureRequest: Request | undefined;
    const http = {
      fetch: async (request: Request) => {
        captureRequest = request;
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
    };
    const runtime = createCloudflareRuntime({ http });

    await runtime.browserRunCapture({
      action: "screenshot",
      input: { html: "<h1>Hello</h1>" },
    });

    expect(timeout).toHaveBeenCalledWith(60_000);
    abortController.abort();
    assert(captureRequest?.signal.aborted);
  });

  test("classifies missing capture configuration as NotConfiguredError", async () => {
    const runtime = createCloudflareRuntime({ http: createNotConfiguredHttp() });

    await expect(
      runtime.browserRunCapture({
        action: "screenshot",
        input: { html: "<h1>Hello</h1>" },
      }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
