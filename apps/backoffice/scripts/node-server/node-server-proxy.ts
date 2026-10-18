import type { Express } from "express";

import {
  isNodeBackofficeRequestOriginAllowed,
  requireNodeBackofficePublicOrigin,
} from "../server/node-request-origin";

/** Accept the public origin and direct HTTP loopback hosts only from a loopback socket. */
export function configureNodeBackofficeProxy(
  app: Express,
  publicBaseUrl: string,
  trustedProxy: string,
): void {
  const publicOrigin = requireNodeBackofficePublicOrigin(publicBaseUrl);
  app.set("trust proxy", trustedProxy === "false" ? false : trustedProxy);
  app.use((request, response, next) => {
    const hasForwardingHeaders = [
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "forwarded",
    ].some((name) => request.headers[name] !== undefined);
    // React Router must use the original Host, never a forwarded host.
    delete request.headers["x-forwarded-host"];
    const forwardedProto = request.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwardedProto && forwardedProto !== request.protocol) {
      delete request.headers["x-forwarded-proto"];
    }
    const host = request.get("host");
    if (!host || (request.protocol !== "http" && request.protocol !== "https")) {
      response.status(400).end();
      return;
    }
    let origin: URL;
    try {
      origin = new URL(`${request.protocol}://${host}`);
    } catch {
      response.status(400).end();
      return;
    }
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      response.status(400).end();
      return;
    }
    if (
      !isNodeBackofficeRequestOriginAllowed({
        origin,
        publicOrigin,
        hasForwardingHeaders,
        connection: {
          remoteAddress: request.socket.remoteAddress ?? null,
          localPort: request.socket.localPort ?? null,
        },
      })
    ) {
      response.status(421).end();
      return;
    }
    next();
  });
}
