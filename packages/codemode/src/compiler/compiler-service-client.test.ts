import { afterEach, expect, test, vi } from "vitest";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  authenticateCodemodeHttpRequest,
  CodemodeHttpAuthenticationError,
} from "../transport/codemode-http-authentication";
import {
  CodemodeCompilerHttpError,
  createCodemodeCompilerHttpClient,
} from "./compiler-service-client";

const bridge = { url: "https://bridge.example.com/", apiKey: "test-api-key" };
const typeCheckInput = {
  files: [{ path: "example.js", read: async () => "const value = 42;" }],
  sourcePaths: ["example.js"],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("compiler HTTP clients preserve authoritative authentication failures", async () => {
  const authenticationResponse = await authenticateCodemodeHttpRequest(
    new Request(bridge.url, { headers: { authorization: "Bearer incorrect" } }),
    bridge.apiKey,
  );
  if (!authenticationResponse) {
    throw new Error("Expected codemode authentication to reject the incorrect bearer token.");
  }
  vi.spyOn(globalThis, "fetch").mockResolvedValue(authenticationResponse);
  const client = createCodemodeCompilerHttpClient(bridge);

  await expect(client.typeCheckFiles(typeCheckInput)).rejects.toMatchObject({
    name: CodemodeHttpAuthenticationError.name,
    code: "AUTHENTICATION_FAILED",
    message: "Codemode HTTP authentication failed.",
  });
});

test("proxy 503 responses are not mislabeled as authentication configuration failures", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Service unavailable", { status: 503 }),
  );
  const client = createCodemodeCompilerHttpClient(bridge);

  await expect(client.typeCheckFiles(typeCheckInput)).rejects.toMatchObject({
    name: CodemodeCompilerHttpError.name,
    code: "UNEXPECTED_HTTP_RESPONSE",
  });
});

test("compiler HTTP requests abort at the shared compilation deadline", async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    return await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          const reason = request.signal.reason;
          reject(reason instanceof Error ? reason : new Error("Request aborted"));
        },
        { once: true },
      );
    });
  });
  const client = createCodemodeCompilerHttpClient(bridge);
  const rejection = expect(client.typeCheckFiles(typeCheckInput)).rejects.toMatchObject({
    name: CodemodeCompilerHttpError.name,
    code: "REQUEST_TIMED_OUT",
  });

  await vi.advanceTimersByTimeAsync(CODEMODE_LIMITS.compileTimeoutMs);
  await rejection;
});
