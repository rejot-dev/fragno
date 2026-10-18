import type { NodeObjectRuntimeHostConnection } from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";
import express from "express";

import {
  isNodeBackofficeRequestOriginAllowed,
  requireNodeBackofficePublicOrigin,
} from "../server/node-request-origin";

/** Fetch ingress uses Express's proxy trust policy, but never trusts a forwarded host. */
export function createGraftBackofficeRequestNormalizer(
  publicBaseUrl: string,
  trustedProxy: string,
) {
  const publicOrigin = requireNodeBackofficePublicOrigin(publicBaseUrl);
  const policy = express();
  policy.set("trust proxy", trustedProxy === "false" ? false : trustedProxy);
  const trust = policy.get("trust proxy fn") as (address: string, index: number) => boolean;
  return function normalizeGraftBackofficeRequest(
    request: Request,
    connection: Pick<NodeObjectRuntimeHostConnection, "remoteAddress" | "localPort">,
  ): Request | Response {
    const headers = new Headers(request.headers);
    const hasForwardingHeaders = [
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "forwarded",
    ].some((name) => headers.has(name));
    headers.delete("x-forwarded-host");
    const target = new URL(request.url);
    const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwardedProto && connection.remoteAddress !== null && trust(connection.remoteAddress, 0)) {
      if (forwardedProto !== "http" && forwardedProto !== "https") {
        return new Response(null, { status: 400 });
      }
      target.protocol = `${forwardedProto}:`;
    } else {
      headers.delete("x-forwarded-proto");
    }
    // The socket listener is HTTP; URL authority still comes from the original Host header.
    const host = headers.get("host");
    if (!host) {
      return new Response(null, { status: 400 });
    }
    let origin: URL;
    try {
      origin = new URL(`${target.protocol}//${host}`);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      !isNodeBackofficeRequestOriginAllowed({
        origin,
        publicOrigin,
        connection,
        hasForwardingHeaders,
      })
    ) {
      return new Response(null, { status: 421 });
    }
    target.host = origin.host;
    return new Request(target, new Request(request, { headers }));
  };
}
