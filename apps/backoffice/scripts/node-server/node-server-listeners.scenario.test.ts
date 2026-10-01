import { assert, test } from "vitest";

import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

import { startNodeBackofficeListeners, stopNodeBackofficeListeners } from "./node-server-listeners";

test("Node listener shutdown drains an ordinary response before closing", async () => {
  let releaseHandler: () => void = () => {};
  const handlerCanFinish = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let resolveHandlerStarted: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => {
    resolveHandlerStarted = resolve;
  });
  const listeners = await startNodeBackofficeListeners({
    hosts: ["127.0.0.1"],
    port: 0,
    requestListener(_request, response) {
      resolveHandlerStarted();
      void handlerCanFinish.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("mutation completed");
      });
    },
  });
  const address = listeners[0].server.address();
  assert(address && typeof address !== "string");

  const request = get(`http://127.0.0.1:${address.port}/mutation`);
  const responseReceived = once(request, "response");
  await handlerStarted;

  let shutdownCompleted = false;
  const shutdown = stopNodeBackofficeListeners(listeners, 1_000).then(() => {
    shutdownCompleted = true;
  });
  await wait(25);
  assert.equal(shutdownCompleted, false);

  releaseHandler();
  const [clientResponse] = await responseReceived;
  let body = "";
  clientResponse.setEncoding("utf8");
  for await (const chunk of clientResponse) {
    body += chunk;
  }
  await shutdown;

  assert.equal(clientResponse.statusCode, 200);
  assert.equal(body, "mutation completed");
  assert.equal(listeners[0].activeResponses.size, 0);
});

test("Node listener shutdown force-closes a stream after the drain deadline", async () => {
  let resolveServerResponseClosed: () => void = () => {};
  const serverResponseClosed = new Promise<void>((resolve) => {
    resolveServerResponseClosed = resolve;
  });
  const listeners = await startNodeBackofficeListeners({
    hosts: ["127.0.0.1"],
    port: 0,
    requestListener(_request, response) {
      response.once("close", resolveServerResponseClosed);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"started"}\n');
    },
  });
  const address = listeners[0].server.address();
  assert(address && typeof address !== "string");

  const request = get(`http://127.0.0.1:${address.port}/stream`);
  request.on("error", () => {});
  const [clientResponse] = await once(request, "response");
  clientResponse.on("error", () => {});
  await once(clientResponse, "data");

  await Promise.race([
    stopNodeBackofficeListeners(listeners, 25),
    wait(1_000).then(() => {
      throw new Error("Node Backoffice listener shutdown did not close the active stream.");
    }),
  ]);
  await serverResponseClosed;

  assert.equal(listeners[0].activeResponses.size, 0);
});
