import { randomUUID } from "node:crypto";

import type { Express } from "express";

import { trace } from "@opentelemetry/api";

function googleCloudTraceName(traceId: string): string {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  return projectId ? `projects/${projectId}/traces/${traceId}` : traceId;
}

export function registerNodeBackofficeRequestObservability(app: Express): void {
  app.use((request, response, next) => {
    const requestId = randomUUID();
    const activeSpan = trace.getActiveSpan();
    const spanContext = activeSpan?.spanContext();
    const startedAt = performance.now();
    let completionLogged = false;

    response.setHeader("backoffice-request-id", requestId);
    activeSpan?.setAttribute("backoffice.request_id", requestId);

    function logRequestCompletion(outcome: "aborted" | "completed"): void {
      if (completionLogged) {
        return;
      }
      completionLogged = true;
      response.off("finish", logCompletedRequest);
      response.off("close", logClosedRequest);

      console.info(
        JSON.stringify({
          severity: "INFO",
          message:
            outcome === "completed" ? "Backoffice request completed" : "Backoffice request aborted",
          event: "backoffice.request.completed",
          outcome,
          "backoffice.request_id": requestId,
          trace_id: spanContext?.traceId,
          span_id: spanContext?.spanId,
          "logging.googleapis.com/trace": spanContext
            ? googleCloudTraceName(spanContext.traceId)
            : undefined,
          "logging.googleapis.com/spanId": spanContext?.spanId,
          method: request.method,
          path: request.path,
          status: response.headersSent ? response.statusCode : null,
          duration_ms: performance.now() - startedAt,
        }),
      );
    }

    function logCompletedRequest(): void {
      logRequestCompletion("completed");
    }

    function logClosedRequest(): void {
      logRequestCompletion(response.writableFinished ? "completed" : "aborted");
    }

    response.once("finish", logCompletedRequest);
    response.once("close", logClosedRequest);
    next();
  });
}
