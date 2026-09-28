import type { Express } from "express";

/** Registers the load-balancer health check before canonical public-origin enforcement. */
export function registerNodeBackofficeHealthCheck(app: Express): void {
  app.get("/healthz", (_request, response) => {
    response.status(200).type("text/plain").send("ok\n");
  });
}
