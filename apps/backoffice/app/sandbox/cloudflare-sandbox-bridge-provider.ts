import type { SandboxContainerControl } from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import { createCloudflareBridgeHttpUrl } from "@fragno-dev/codemode/transport/cloudflare-bridge-url";
import { readCodemodeHttpAuthenticationError } from "@fragno-dev/codemode/transport/codemode-http-authentication";

import type { SandboxRuntimeProvider } from "./contracts";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "./contracts";
import { SandboxRuntimeError } from "./sandbox-runtime-error";

// Starting includes booting the container, and snapshots copy its whole filesystem.
const SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_BRIDGE_COMMAND_TRANSPORT_GRACE_MS = 10_000;

type CloudflareSandboxBridgeProviderOptions = {
  bridgeUrl: string;
  apiKey: string;
  resolveSandboxId: (sandboxId: string) => string | Promise<string>;
};

type CloudflareSandboxBridgeRequest = {
  bridgeUrl: string;
  apiKey: string;
  pathname: string;
  method: "POST" | "DELETE";
  body: unknown;
  timeoutMs: number;
};

/** Controls Cloudflare sandboxes through the authenticated bridge HTTP API. */
export function createCloudflareSandboxBridgeProvider({
  bridgeUrl,
  apiKey,
  resolveSandboxId,
}: CloudflareSandboxBridgeProviderOptions): SandboxRuntimeProvider {
  if (!apiKey.trim()) {
    throw new Error("Cloudflare sandbox bridge API key must not be empty.");
  }
  createCloudflareBridgeHttpUrl(bridgeUrl, "/");

  return {
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    async getHandle(id: string): Promise<SandboxContainerControl> {
      const pathname = `/v1/sandbox/${await resolveSandboxId(id)}`;
      const request = { bridgeUrl, apiKey, timeoutMs: SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS };
      // Responses come from this repository's bridge, which owns the outcome contract.
      return {
        start: async (startRequest) =>
          await (
            await sendCloudflareSandboxBridgeRequest({
              ...request,
              pathname: `${pathname}/start`,
              method: "POST",
              body: startRequest,
            })
          ).json(),
        exec: async (execRequest) =>
          await (
            await sendCloudflareSandboxBridgeRequest({
              ...request,
              pathname: `${pathname}/exec`,
              method: "POST",
              body: execRequest,
              timeoutMs: execRequest.timeoutMs + SANDBOX_BRIDGE_COMMAND_TRANSPORT_GRACE_MS,
            })
          ).json(),
        snapshot: async () =>
          await (
            await sendCloudflareSandboxBridgeRequest({
              ...request,
              pathname: `${pathname}/snapshot`,
              method: "POST",
              body: null,
            })
          ).json(),
        stop: async () => {
          await sendCloudflareSandboxBridgeRequest({
            ...request,
            pathname,
            method: "DELETE",
            body: null,
          });
        },
      };
    },
  };
}

async function sendCloudflareSandboxBridgeRequest(
  input: CloudflareSandboxBridgeRequest,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(createCloudflareBridgeHttpUrl(input.bridgeUrl, input.pathname), {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        ...(input.body === null ? {} : { "content-type": "application/json" }),
      },
      body: input.body === null ? null : JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SandboxRuntimeError({
      code: timedOut ? "request_timed_out" : "bridge_unreachable",
      reason: timedOut ? "timeout" : "sandbox_unavailable",
      retryable: true,
      message: timedOut
        ? `Cloudflare sandbox bridge request timed out after ${input.timeoutMs}ms.`
        : `Cloudflare sandbox bridge is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!response.ok) {
    throw await readCloudflareSandboxBridgeError(response);
  }
  return response;
}

async function readCloudflareSandboxBridgeError(response: Response): Promise<SandboxRuntimeError> {
  const authenticationError = await readCodemodeHttpAuthenticationError(response.clone());
  if (authenticationError) {
    return new SandboxRuntimeError({
      code: authenticationError.code,
      reason: "authentication_failed",
      retryable: false,
      message: `Cloudflare sandbox bridge authentication failed: ${authenticationError.message}`,
    });
  }

  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    error?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code : "unexpected_http_response";
  const detail = typeof body?.error === "string" ? body.error : `HTTP status ${response.status}`;
  const invalidRequest = response.status === 400;
  return new SandboxRuntimeError({
    code,
    reason: invalidRequest ? "invalid_request" : "sandbox_unavailable",
    retryable: !invalidRequest,
    message: `Cloudflare sandbox bridge request failed (${code}): ${detail}`,
  });
}
