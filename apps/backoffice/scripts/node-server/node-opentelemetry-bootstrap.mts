import { registerNodeOpenTelemetryLifecycle } from "../../app/backoffice-runtime/node/node-opentelemetry-lifecycle";

function inferBackofficeProcessRole(): "processor" | "web" {
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.includes("node-hook-processor") ? "processor" : "web";
}

function appendOpenTelemetryResourceAttribute(
  attributes: string | undefined,
  name: string,
  value: string,
): string {
  const existing = attributes
    ?.split(",")
    .map((attribute) => attribute.trim())
    .filter(Boolean);
  if (existing?.some((attribute) => attribute.startsWith(`${name}=`))) {
    return existing.join(",");
  }
  return [...(existing ?? []), `${name}=${value}`].join(",");
}

const nodeOpenTelemetryExportTimeoutMs = 3_000;
const exporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const telemetryDisabled = process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";

if (exporterEndpoint && !telemetryDisabled) {
  const processRole = process.env.BACKOFFICE_PROCESS_ROLE ?? inferBackofficeProcessRole();
  process.env.OTEL_SERVICE_NAME ??=
    processRole === "processor" ? "rejot-backoffice-processor" : "rejot-backoffice-web";
  process.env.OTEL_PROPAGATORS ??= "tracecontext";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  process.env.OTEL_RESOURCE_ATTRIBUTES = appendOpenTelemetryResourceAttribute(
    appendOpenTelemetryResourceAttribute(
      process.env.OTEL_RESOURCE_ATTRIBUTES,
      "service.namespace",
      "rejot-backoffice",
    ),
    "backoffice.process.role",
    processRole,
  );

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { ExpressInstrumentation },
    { UndiciInstrumentation },
    { RuntimeNodeInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-runtime-node"),
  ]);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ timeoutMillis: nodeOpenTelemetryExportTimeoutMs }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ timeoutMillis: nodeOpenTelemetryExportTimeoutMs }),
        exportTimeoutMillis: nodeOpenTelemetryExportTimeoutMs,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url === "/healthz",
      }),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });

  sdk.start();
  registerNodeOpenTelemetryLifecycle({
    shutdown: async () => {
      await sdk.shutdown();
    },
  });
}
