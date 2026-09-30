import { createCloudflareBridgeHttpUrl } from "@fragno-dev/codemode/transport/cloudflare-bridge-url";

import type {
  MountBucketOptions,
  SandboxRuntimeExecResult,
  SandboxRuntimeHandle,
  SandboxRuntimeHandleOptions,
  SandboxRuntimeProvider,
  WriteFileOptions,
} from "./contracts";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "./contracts";
import { executeSandboxRuntimeCommand } from "./sandbox-command-result";
import { SandboxRuntimeError } from "./sandbox-runtime-error";

const SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS = 60_000;
const SANDBOX_BRIDGE_DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const SANDBOX_BRIDGE_COMMAND_TRANSPORT_GRACE_MS = 5_000;
const SANDBOX_BRIDGE_MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES = 6 * 1024 * 1024;

type CloudflareSandboxBridgeProviderOptions = {
  bridgeUrl: string;
  apiKey: string;
  resolveSandboxId: (sandboxId: string) => string | Promise<string>;
};

type CloudflareSandboxBridgeExecEvent =
  | { event: "stdout" | "stderr"; data: string }
  | { event: "exit"; data: string }
  | { event: "error"; data: string };

/** Uses the authenticated Cloudflare bridge HTTP API as a Backoffice sandbox runtime provider. */
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
    async getHandle(id: string, options: SandboxRuntimeHandleOptions = {}) {
      const physicalSandboxId = await resolveSandboxId(id);
      if (!/^[a-z2-7]{1,128}$/.test(physicalSandboxId)) {
        throw new SandboxRuntimeError({
          code: "invalid_sandbox_id",
          reason: "invalid_request",
          retryable: false,
          message: `Cloudflare sandbox bridge resolver returned an invalid physical ID for "${id}".`,
        });
      }
      if (options.keepAlive !== undefined || options.sleepAfter !== undefined) {
        await configureCloudflareSandboxBridgeLifecycle({
          bridgeUrl,
          apiKey,
          physicalSandboxId,
          options,
        });
      }
      return createCloudflareSandboxBridgeHandle({
        id,
        physicalSandboxId,
        bridgeUrl,
        apiKey,
      });
    },
  };
}

function createCloudflareSandboxBridgeHandle(input: {
  id: string;
  physicalSandboxId: string;
  bridgeUrl: string;
  apiKey: string;
}): SandboxRuntimeHandle {
  const executeArgv = async (
    argv: string[],
    timeoutMs: number | undefined,
  ): Promise<SandboxRuntimeExecResult> =>
    await executeCloudflareSandboxBridgeCommand({
      ...input,
      argv,
      timeoutMs,
    });

  return {
    id: input.id,
    exec: async (command, options) => await executeArgv(["sh", "-lc", command], options?.timeout),
    destroy: async () => {
      await runCloudflareSandboxBridgeRequest({
        ...input,
        pathname: `/v1/sandbox/${input.physicalSandboxId}`,
        requestInit: { method: "DELETE" },
        timeoutMs: SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS,
        readResponse: discardCloudflareSandboxBridgeResponse,
      });
    },
    mountBucket: async (bucket, mountPoint, options) => {
      await runCloudflareSandboxBridgeRequest({
        ...input,
        pathname: `/v1/sandbox/${input.physicalSandboxId}/mount`,
        requestInit: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bucket,
            mountPath: mountPoint,
            options: createCloudflareSandboxBridgeMountOptions(options),
          }),
        },
        timeoutMs: SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS,
        readResponse: discardCloudflareSandboxBridgeResponse,
      });
    },
    mkdir: async (path, options) => {
      const result = await executeArgv(
        ["mkdir", ...(options?.recursive ? ["-p"] : []), path],
        SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS,
      );
      assertCloudflareSandboxBridgeCommandSucceeded("mkdir", result);
    },
    writeFile: async (path, content, options) => {
      const bytes = decodeCloudflareSandboxBridgeFileContent(content, options);
      await runCloudflareSandboxBridgeRequest({
        ...input,
        pathname: createCloudflareSandboxBridgeFilePath(input.physicalSandboxId, path),
        requestInit: {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes as BodyInit,
        },
        timeoutMs: SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS,
        readResponse: discardCloudflareSandboxBridgeResponse,
      });
    },
    exists: async (path) => {
      const result = await executeArgv(["test", "-e", path], SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS);
      if (result.exitCode === 0) {
        return { exists: true };
      }
      if (result.exitCode === 1) {
        return { exists: false };
      }
      assertCloudflareSandboxBridgeCommandSucceeded("test file existence", result);
      return { exists: false };
    },
    executeCommand: async (command, options) =>
      await executeSandboxRuntimeCommand(
        async (runtimeCommand, runtimeOptions) =>
          await executeArgv(["sh", "-lc", runtimeCommand], runtimeOptions?.timeout),
        command,
        options,
      ),
  };
}

async function configureCloudflareSandboxBridgeLifecycle(input: {
  bridgeUrl: string;
  apiKey: string;
  physicalSandboxId: string;
  options: SandboxRuntimeHandleOptions;
}): Promise<void> {
  await runCloudflareSandboxBridgeRequest({
    ...input,
    pathname: `/v1/sandbox/${input.physicalSandboxId}/configuration`,
    requestInit: {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.options.keepAlive !== undefined ? { keepAlive: input.options.keepAlive } : {}),
        ...(input.options.sleepAfter !== undefined ? { sleepAfter: input.options.sleepAfter } : {}),
      }),
    },
    timeoutMs: SANDBOX_BRIDGE_OPERATION_TIMEOUT_MS,
    readResponse: discardCloudflareSandboxBridgeResponse,
  });
}

async function executeCloudflareSandboxBridgeCommand(input: {
  bridgeUrl: string;
  apiKey: string;
  physicalSandboxId: string;
  argv: string[];
  timeoutMs: number | undefined;
}): Promise<SandboxRuntimeExecResult> {
  const commandTimeoutMs = input.timeoutMs ?? SANDBOX_BRIDGE_DEFAULT_COMMAND_TIMEOUT_MS;
  return await runCloudflareSandboxBridgeRequest({
    ...input,
    pathname: `/v1/sandbox/${input.physicalSandboxId}/exec`,
    requestInit: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        argv: input.argv,
        timeout_ms: commandTimeoutMs,
      }),
    },
    timeoutMs: commandTimeoutMs + SANDBOX_BRIDGE_COMMAND_TRANSPORT_GRACE_MS,
    readResponse: readCloudflareSandboxBridgeExecResponse,
  });
}

function createCloudflareSandboxBridgeError(
  code: string,
  message: string,
  httpStatus: number | null,
): SandboxRuntimeError {
  if (code === "request_timed_out") {
    return new SandboxRuntimeError({ code, reason: "timeout", retryable: true, message });
  }
  if (
    code === "capacity_exceeded" ||
    code === "pool_error" ||
    code === "exec_error" ||
    code === "exec_transport_error"
  ) {
    return new SandboxRuntimeError({
      code,
      reason: "sandbox_unavailable",
      retryable: true,
      message,
    });
  }
  if (
    code === "unauthorized" ||
    code === "authentication_not_configured" ||
    code === "AUTHENTICATION_FAILED" ||
    code === "AUTHENTICATION_NOT_CONFIGURED"
  ) {
    return new SandboxRuntimeError({
      code,
      reason: "authentication_failed",
      retryable: false,
      message,
    });
  }
  if (code === "invalid_request" || code === "payload_too_large") {
    return new SandboxRuntimeError({
      code,
      reason: "invalid_request",
      retryable: false,
      message,
    });
  }
  if (code === "output_limit_exceeded") {
    return new SandboxRuntimeError({
      code,
      reason: "output_limit_exceeded",
      retryable: false,
      message,
    });
  }
  if (code === "command_failed") {
    return new SandboxRuntimeError({ code, reason: "command_failed", retryable: false, message });
  }
  if (httpStatus !== null && httpStatus >= 500 && code !== "invalid_error_response") {
    return new SandboxRuntimeError({
      code,
      reason: "sandbox_unavailable",
      retryable: true,
      message,
    });
  }
  return new SandboxRuntimeError({ code, reason: "internal_error", retryable: false, message });
}

async function runCloudflareSandboxBridgeRequest<T>(input: {
  bridgeUrl: string;
  apiKey: string;
  pathname: string;
  requestInit: RequestInit;
  timeoutMs: number;
  readResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutError = createCloudflareSandboxBridgeError(
    "request_timed_out",
    `Cloudflare sandbox bridge request timed out after ${input.timeoutMs}ms.`,
    null,
  );
  const deadline = setTimeout(() => {
    controller.abort(timeoutError);
  }, input.timeoutMs);
  try {
    const headers = new Headers(input.requestInit.headers);
    headers.set("authorization", `Bearer ${input.apiKey}`);
    const response = await fetch(
      new Request(createCloudflareBridgeHttpUrl(input.bridgeUrl, input.pathname), {
        ...input.requestInit,
        headers,
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      throw await readCloudflareSandboxBridgeError(response);
    }
    return await input.readResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function discardCloudflareSandboxBridgeResponse(response: Response): Promise<void> {
  await response.arrayBuffer();
}

async function readCloudflareSandboxBridgeError(response: Response): Promise<SandboxRuntimeError> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return createCloudflareSandboxBridgeError(
      "unexpected_http_response",
      `Cloudflare sandbox bridge returned unexpected HTTP status ${response.status}.`,
      response.status,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createCloudflareSandboxBridgeError(
      "invalid_error_response",
      `Cloudflare sandbox bridge returned an invalid error response with status ${response.status}.`,
      response.status,
    );
  }
  const code = (value as Record<string, unknown>).code;
  const error = (value as Record<string, unknown>).error;
  if (typeof code !== "string" || typeof error !== "string") {
    return createCloudflareSandboxBridgeError(
      "invalid_error_response",
      `Cloudflare sandbox bridge returned an invalid error response with status ${response.status}.`,
      response.status,
    );
  }
  const prefix =
    response.status === 502 || response.status === 503
      ? "Bridge unavailable"
      : "Bridge request failed";
  return createCloudflareSandboxBridgeError(
    code,
    `Cloudflare sandbox ${prefix.toLowerCase()} (${code}): ${error}`,
    response.status,
  );
}

async function readCloudflareSandboxBridgeExecResponse(
  response: Response,
): Promise<SandboxRuntimeExecResult> {
  if (!response.body) {
    throw createCloudflareSandboxBridgeError(
      "invalid_exec_response",
      "Cloudflare sandbox bridge execution response has no body.",
      null,
    );
  }

  const reader = response.body.getReader();
  const eventDecoder = new TextDecoder();
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let eventBuffer = "";
  let outputBytes = 0;
  let exitCode: number | null = null;
  let complete = false;

  async function processEventBlock(block: string): Promise<void> {
    const event = parseCloudflareSandboxBridgeExecEvent(block);
    if (!event) {
      return;
    }
    if (complete) {
      throw createCloudflareSandboxBridgeError(
        "invalid_exec_response",
        "Cloudflare sandbox bridge returned an execution event after the exit event.",
        null,
      );
    }
    if (event.event === "stdout" || event.event === "stderr") {
      const bytes = decodeCloudflareSandboxBridgeBase64(event.data);
      outputBytes += bytes.byteLength;
      if (outputBytes > SANDBOX_BRIDGE_MAX_COMMAND_OUTPUT_BYTES) {
        throw createCloudflareSandboxBridgeError(
          "output_limit_exceeded",
          `Cloudflare sandbox command output exceeded ${SANDBOX_BRIDGE_MAX_COMMAND_OUTPUT_BYTES} bytes.`,
          null,
        );
      }
      if (event.event === "stdout") {
        stdoutChunks.push(stdoutDecoder.decode(bytes, { stream: true }));
      } else {
        stderrChunks.push(stderrDecoder.decode(bytes, { stream: true }));
      }
      return;
    }
    if (event.event === "error") {
      throw parseCloudflareSandboxBridgeExecError(event.data);
    }

    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      throw createCloudflareSandboxBridgeError(
        "invalid_exec_response",
        "Cloudflare sandbox bridge returned an invalid execution exit event.",
        null,
      );
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Number.isInteger((value as Record<string, unknown>).exit_code)
    ) {
      throw createCloudflareSandboxBridgeError(
        "invalid_exec_response",
        "Cloudflare sandbox bridge returned an invalid execution exit event.",
        null,
      );
    }
    exitCode = (value as { exit_code: number }).exit_code;
    complete = true;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      eventBuffer += eventDecoder.decode(value as Uint8Array, { stream: true });
      let separator = /\r?\n\r?\n/.exec(eventBuffer);
      while (separator) {
        if (separator.index > SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES) {
          throw createCloudflareSandboxBridgeError(
            "invalid_exec_response",
            `Cloudflare sandbox bridge execution event exceeded ${SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES} bytes.`,
            null,
          );
        }
        await processEventBlock(eventBuffer.slice(0, separator.index));
        eventBuffer = eventBuffer.slice(separator.index + separator[0].length);
        separator = /\r?\n\r?\n/.exec(eventBuffer);
      }
      if (eventBuffer.length > SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES) {
        throw createCloudflareSandboxBridgeError(
          "invalid_exec_response",
          `Cloudflare sandbox bridge execution event exceeded ${SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES} bytes.`,
          null,
        );
      }
    }
    eventBuffer += eventDecoder.decode();
    if (eventBuffer.length > SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES) {
      throw createCloudflareSandboxBridgeError(
        "invalid_exec_response",
        `Cloudflare sandbox bridge execution event exceeded ${SANDBOX_BRIDGE_MAX_EVENT_BUFFER_BYTES} bytes.`,
        null,
      );
    }
    if (eventBuffer.trim()) {
      await processEventBlock(eventBuffer);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  stdoutChunks.push(stdoutDecoder.decode());
  stderrChunks.push(stderrDecoder.decode());
  if (!complete || exitCode === null) {
    throw createCloudflareSandboxBridgeError(
      "incomplete_exec_response",
      "Cloudflare sandbox bridge execution response ended before the exit event.",
      null,
    );
  }
  return {
    success: exitCode === 0,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function parseCloudflareSandboxBridgeExecEvent(
  block: string,
): CloudflareSandboxBridgeExecEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  let hasProtocolField = false;
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    hasProtocolField = true;
    if (line.startsWith("event:")) {
      if (event !== null) {
        throw createCloudflareSandboxBridgeError(
          "invalid_exec_response",
          "Cloudflare sandbox bridge returned duplicate execution event fields.",
          null,
        );
      }
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    } else {
      throw createCloudflareSandboxBridgeError(
        "invalid_exec_response",
        "Cloudflare sandbox bridge returned an unsupported execution event field.",
        null,
      );
    }
  }
  if (!hasProtocolField) {
    return null;
  }
  if (event !== "stdout" && event !== "stderr" && event !== "exit" && event !== "error") {
    throw createCloudflareSandboxBridgeError(
      "invalid_exec_response",
      `Cloudflare sandbox bridge returned unknown execution event "${event ?? "missing"}".`,
      null,
    );
  }
  return { event, data: data.join("\n") };
}

function parseCloudflareSandboxBridgeExecError(data: string): SandboxRuntimeError {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return createCloudflareSandboxBridgeError(
      "invalid_exec_error",
      "Cloudflare sandbox bridge returned an invalid execution error event.",
      null,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createCloudflareSandboxBridgeError(
      "invalid_exec_error",
      "Cloudflare sandbox bridge returned an invalid execution error event.",
      null,
    );
  }
  const code = (value as Record<string, unknown>).code;
  const error = (value as Record<string, unknown>).error;
  if (typeof code !== "string" || typeof error !== "string") {
    return createCloudflareSandboxBridgeError(
      "invalid_exec_error",
      "Cloudflare sandbox bridge returned an invalid execution error event.",
      null,
    );
  }
  return createCloudflareSandboxBridgeError(
    code,
    `Cloudflare sandbox execution failed: ${error}`,
    null,
  );
}

function decodeCloudflareSandboxBridgeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw createCloudflareSandboxBridgeError(
      "invalid_exec_response",
      "Cloudflare sandbox bridge returned invalid base64 command output.",
      null,
    );
  }
}

function decodeCloudflareSandboxBridgeFileContent(
  content: string,
  options: WriteFileOptions | undefined,
): Uint8Array {
  return options?.encoding === "base64"
    ? decodeCloudflareSandboxBridgeBase64(content)
    : new TextEncoder().encode(content);
}

function createCloudflareSandboxBridgeFilePath(physicalSandboxId: string, path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments[0] !== "workspace") {
    throw new Error(`Cloudflare sandbox bridge file path must be inside /workspace: ${path}`);
  }
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `/v1/sandbox/${physicalSandboxId}/file/${encodedPath}`;
}

function createCloudflareSandboxBridgeMountOptions(options: MountBucketOptions) {
  const unsupportedOptions = [
    ...(options.region !== undefined ? ["region"] : []),
    ...(options.credentials?.sessionToken !== undefined ? ["credentials.sessionToken"] : []),
    ...(options.provider !== undefined ? ["provider"] : []),
  ];
  if (unsupportedOptions.length > 0) {
    throw new Error(
      `Cloudflare sandbox bridge bucket mounts do not support ${unsupportedOptions.join(
        ", ",
      )}; these options would be ignored by the bridge.`,
    );
  }
  return {
    endpoint: options.endpoint,
    ...(options.credentials
      ? {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          },
        }
      : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.pathStyle ? { s3fsOptions: ["use_path_request_style"] } : {}),
  };
}

function assertCloudflareSandboxBridgeCommandSucceeded(
  operation: string,
  result: SandboxRuntimeExecResult,
): void {
  if (result.success) {
    return;
  }
  throw createCloudflareSandboxBridgeError(
    "command_failed",
    `Cloudflare sandbox bridge ${operation} failed with exit code ${result.exitCode ?? "unknown"}: ${result.stderr || result.stdout}`,
    null,
  );
}
