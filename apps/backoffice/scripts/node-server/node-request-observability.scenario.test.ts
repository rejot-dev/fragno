import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { once } from "node:events";
import { request as httpRequest } from "node:http";

import express from "express";

import { context, propagation, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";

import { registerNodeBackofficeRequestObservability } from "./node-request-observability";

function sendRequest(port: number): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/automations/42?view=summary",
        method: "POST",
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function abortStreamingRequest(port: number): Promise<string | string[] | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/stream",
        method: "GET",
      },
      (response) => {
        const requestId = response.headers["backoffice-request-id"];
        response.once("data", () => response.destroy());
        response.once("close", () => resolve(requestId));
        response.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "ECONNRESET") {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("Node Backoffice request observability", () => {
  let provider: InstanceType<typeof node.NodeTracerProvider> | null = null;

  afterEach(async () => {
    await provider?.shutdown();
    provider = null;
    trace.disable();
    context.disable();
    propagation.disable();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("correlates the response, active HTTP span, and structured completion log", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "backoffice-production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const exporter = new tracing.InMemorySpanExporter();
    provider = new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const tracer = trace.getTracer("node-request-observability-scenario");
    const app = express();
    app.use((_request, response, next) => {
      tracer.startActiveSpan("http.request", (span) => {
        response.once("finish", () => span.end());
        next();
      });
    });
    registerNodeBackofficeRequestObservability(app);
    app.post("/automations/:automationId", (_request, response) => {
      response.status(202).end();
    });

    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string");

      const result = await sendRequest(address.port);
      assert.equal(result.status, 202);
      const requestId = result.headers["backoffice-request-id"];
      expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));

      await provider.forceFlush();
      const requestSpan = exporter.getFinishedSpans().find((span) => span.name === "http.request");
      expect(requestSpan?.attributes["backoffice.request_id"]).toBe(requestId);

      expect(info).toHaveBeenCalledTimes(1);
      const completionLog = JSON.parse(info.mock.calls[0]?.[0] as string);
      expect(completionLog).toEqual({
        severity: "INFO",
        message: "Backoffice request completed",
        event: "backoffice.request.completed",
        outcome: "completed",
        "backoffice.request_id": requestId,
        trace_id: requestSpan?.spanContext().traceId,
        span_id: requestSpan?.spanContext().spanId,
        "logging.googleapis.com/trace": `projects/backoffice-production/traces/${requestSpan?.spanContext().traceId}`,
        "logging.googleapis.com/spanId": requestSpan?.spanContext().spanId,
        method: "POST",
        path: "/automations/42",
        status: 202,
        duration_ms: expect.any(Number),
      });
      expect(completionLog.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("logs a prematurely closed response once as aborted", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = express();
    registerNodeBackofficeRequestObservability(app);

    let confirmStreamingResponseClosed: () => void = () => {};
    const streamingResponseClosed = new Promise<void>((resolve) => {
      confirmStreamingResponseClosed = resolve;
    });
    app.get("/stream", (_request, response) => {
      response.once("close", confirmStreamingResponseClosed);
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial response");
    });

    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string");

      const requestId = await abortStreamingRequest(address.port);
      await streamingResponseClosed;
      expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      expect(info).toHaveBeenCalledTimes(1);

      const completionLog = JSON.parse(info.mock.calls[0]?.[0] as string);
      expect(completionLog).toEqual({
        severity: "INFO",
        message: "Backoffice request aborted",
        event: "backoffice.request.completed",
        outcome: "aborted",
        "backoffice.request_id": requestId,
        method: "GET",
        path: "/stream",
        status: 200,
        duration_ms: expect.any(Number),
      });
      expect(completionLog.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
