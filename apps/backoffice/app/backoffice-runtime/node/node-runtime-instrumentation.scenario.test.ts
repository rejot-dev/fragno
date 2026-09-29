import { afterEach, describe, expect, test, vi } from "vitest";

import type { DurableHookAttempt } from "@fragno-dev/db/hooks";
import { FragnoId } from "@fragno-dev/db/schema";

import { context, propagation, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";

import { nodeBackofficeRuntimeInstrumentation } from "./node-runtime-instrumentation";

describe("Node Backoffice durable hook trace propagation", () => {
  let provider: InstanceType<typeof node.NodeTracerProvider> | null = null;

  afterEach(async () => {
    await provider?.shutdown();
    provider = null;
    trace.disable();
    context.disable();
    propagation.disable();
    vi.restoreAllMocks();
  });

  test("continues an enqueuing request trace in a later hook attempt", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const exporter = new tracing.InMemorySpanExporter();
    provider = new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const tracer = trace.getTracer("node-runtime-instrumentation-scenario");
    let propagationContext: Readonly<Record<string, string>> | null = null;

    await tracer.startActiveSpan("backoffice.request", async (span) => {
      propagationContext = nodeBackofficeRuntimeInstrumentation.durableHooks.captureContext({
        namespace: "auth",
        hookName: "onOrganizationCreated",
        idempotencyKey: "organization-created-1",
      });
      span.end();
    });

    expect(propagationContext).toEqual(
      expect.objectContaining({
        traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
      }),
    );

    const attempt: DurableHookAttempt = {
      namespace: "auth",
      hookId: FragnoId.fromExternal("hook-1", 0),
      hookName: "onOrganizationCreated",
      idempotencyKey: "organization-created-1",
      attempt: 1,
      maxAttempts: 5,
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
      propagationContext,
    };

    await nodeBackofficeRuntimeInstrumentation.durableHooks.runAttempt(attempt, async () => {});
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const requestSpan = spans.find((span) => span.name === "backoffice.request");
    const attemptSpan = spans.find((span) => span.name === "fragno.durable_hook.attempt");

    expect(requestSpan).toBeDefined();
    expect(attemptSpan).toBeDefined();
    expect(attemptSpan?.spanContext().traceId).toBe(requestSpan?.spanContext().traceId);
    expect(attemptSpan?.parentSpanContext?.spanId).toBe(requestSpan?.spanContext().spanId);
    expect(attemptSpan?.attributes).toMatchObject({
      "fragno.hook.namespace": "auth",
      "fragno.hook.name": "onOrganizationCreated",
      "fragno.hook.has_propagation_context": true,
    });
  });
});
