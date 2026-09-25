import type { Express } from "express";

/** Accept the public origin and direct HTTP loopback hosts only from a loopback socket. */
export function configureNodeBackofficeProxy(
  app: Express,
  publicBaseUrl: string,
  trustedProxy: string,
): void {
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicBaseUrl);
  } catch (cause) {
    throw new Error("Node Backoffice DOCS_PUBLIC_BASE_URL must be an absolute HTTP(S) URL.", {
      cause,
    });
  }
  if (
    (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") ||
    publicUrl.username ||
    publicUrl.password
  ) {
    throw new Error("Node Backoffice DOCS_PUBLIC_BASE_URL must be an absolute HTTP(S) URL.");
  }
  const publicOrigin = publicUrl.origin;

  app.set("trust proxy", trustedProxy === "false" ? false : trustedProxy);
  app.use((request, response, next) => {
    const hasForwardingHeaders =
      request.headers["x-forwarded-host"] !== undefined ||
      request.headers["x-forwarded-proto"] !== undefined ||
      request.headers["x-forwarded-for"] !== undefined ||
      request.headers.forwarded !== undefined;
    // React Router's Express adapter otherwise combines X-Forwarded-Host with the internal
    // Host port. The proxy must preserve the public Host; we do not use X-Forwarded-Host.
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
    let requestUrl: URL;
    try {
      requestUrl = new URL(`${request.protocol}://${host}`);
    } catch {
      response.status(400).end();
      return;
    }
    if (
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.pathname !== "/" ||
      requestUrl.search ||
      requestUrl.hash
    ) {
      response.status(400).end();
      return;
    }
    const peerAddress = request.socket.remoteAddress;
    const isLoopbackPeer =
      peerAddress !== undefined &&
      (peerAddress === "::1" ||
        peerAddress.startsWith("127.") ||
        peerAddress.startsWith("::ffff:127."));
    const isDirectLoopbackHost =
      requestUrl.protocol === "http:" &&
      (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1");
    const localPort = request.socket.localPort;
    const localOrigin =
      isDirectLoopbackHost && localPort !== undefined
        ? new URL(`http://${requestUrl.hostname}:${localPort}`).origin
        : null;
    if (
      isDirectLoopbackHost
        ? !isLoopbackPeer || hasForwardingHeaders || requestUrl.origin !== localOrigin
        : requestUrl.origin !== publicOrigin
    ) {
      response.status(421).end();
      return;
    }
    next();
  });
}
