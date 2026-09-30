import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createCloudflareSandboxBridgeProvider } from "./cloudflare-sandbox-bridge-provider";

const apiKey = "sandbox-provider-test-key";
let bridgeUrl: string;
let writtenFileRequestUrl: string | null = null;
let resolveOverflowResponseClosed: (() => void) | null = null;
let overflowResponseClosed = new Promise<void>((resolve) => {
  resolveOverflowResponseClosed = resolve;
});

const server = createServer((request, response) => {
  void handleSandboxBridgeProviderTestRequest(request, response).catch((error: unknown) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "test_server_error", error: String(error) }));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  bridgeUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function createTestHandle() {
  const provider = createCloudflareSandboxBridgeProvider({
    bridgeUrl,
    apiKey,
    resolveSandboxId: async () => "abc234",
  });
  return provider.getHandle("logical-sandbox");
}

test("bounds combined command output and cancels the bridge stream", async () => {
  overflowResponseClosed = new Promise<void>((resolve) => {
    resolveOverflowResponseClosed = resolve;
  });
  const handle = await createTestHandle();
  const result = await handle.executeCommand("output-overflow", { timeoutMs: 5_000 });

  expect(result).toMatchObject({
    ok: false,
    code: "output_limit_exceeded",
    reason: "output_limit_exceeded",
    retryable: false,
  });
  await expect(
    Promise.race([
      overflowResponseClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Overflow response stream was not cancelled.")), 1_000),
      ),
    ]),
  ).resolves.toBeUndefined();
});

test("preserves retryable bridge execution error codes", async () => {
  const handle = await createTestHandle();
  const result = await handle.executeCommand("transport-error", { timeoutMs: 5_000 });

  expect(result).toEqual({
    ok: false,
    code: "exec_transport_error",
    reason: "sandbox_unavailable",
    message: "Cloudflare sandbox execution failed: connection reset",
    retryable: true,
  });
});

test("preserves permanent authentication errors", async () => {
  const handle = await createTestHandle();
  const result = await handle.executeCommand("authentication-error", { timeoutMs: 5_000 });

  expect(result).toEqual({
    ok: false,
    code: "unauthorized",
    reason: "authentication_failed",
    message: "Cloudflare sandbox bridge request failed (unauthorized): Unauthorized",
    retryable: false,
  });
});

test("accepts SSE heartbeat comments and rejects unknown execution events", async () => {
  const handle = await createTestHandle();
  await expect(handle.executeCommand("heartbeat", { timeoutMs: 5_000 })).resolves.toEqual({
    ok: true,
    stdout: "ready",
    stderr: "",
    exitCode: 0,
  });

  await expect(handle.executeCommand("unknown-event", { timeoutMs: 5_000 })).resolves.toMatchObject(
    {
      ok: false,
      code: "invalid_exec_response",
      reason: "internal_error",
      retryable: false,
    },
  );
});

test("encodes bridge file path segments exactly once", async () => {
  writtenFileRequestUrl = null;
  const handle = await createTestHandle();

  await handle.writeFile("/workspace/my file-é.txt", "contents");

  expect(writtenFileRequestUrl).toBe("/v1/sandbox/abc234/file/workspace/my%20file-%C3%A9.txt");
});

async function handleSandboxBridgeProviderTestRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    sendJson(response, 401, { code: "unauthorized", error: "Unauthorized" });
    return;
  }
  if (request.method === "PUT" && request.url?.startsWith("/v1/sandbox/abc234/file/workspace/")) {
    writtenFileRequestUrl = request.url;
    await readRequestBody(request);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/sandbox/abc234/exec") {
    sendJson(response, 404, { code: "not_found", error: "Not found" });
    return;
  }

  const body = JSON.parse(await readRequestBody(request)) as { argv: string[] };
  const command = body.argv[2];
  if (command === "authentication-error") {
    sendJson(response, 401, { code: "unauthorized", error: "Unauthorized" });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  if (command === "output-overflow") {
    const encodedChunk = Buffer.alloc(128 * 1024, "x").toString("base64");
    let open = true;
    response.on("close", () => {
      open = false;
      resolveOverflowResponseClosed?.();
    });
    const writeOutput = () => {
      if (!open) {
        return;
      }
      response.write(`event: stdout\ndata: ${encodedChunk}\n\n`);
      setImmediate(writeOutput);
    };
    writeOutput();
    return;
  }
  if (command === "transport-error") {
    response.end(
      'event: error\ndata: {"code":"exec_transport_error","error":"connection reset"}\n\n',
    );
    return;
  }
  if (command === "unknown-event") {
    response.end('event: future-output\ndata: ignored\n\nevent: exit\ndata: {"exit_code":0}\n\n');
    return;
  }
  if (command === "heartbeat") {
    response.write(": heartbeat\n\n");
    response.write(`event: stdout\ndata: ${Buffer.from("ready").toString("base64")}\n\n`);
    response.end('event: exit\ndata: {"exit_code":0}\n\n');
    return;
  }
  response.end('event: exit\ndata: {"exit_code":0}\n\n');
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
