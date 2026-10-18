/** Requires an HTTP public origin without credentials before accepting any request. */
export function requireNodeBackofficePublicOrigin(publicBaseUrl: string): string {
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
  return publicUrl.origin;
}

/** Direct loopback origins require socket provenance; forwarded requests require the public origin. */
export function isNodeBackofficeRequestOriginAllowed(input: {
  origin: URL;
  publicOrigin: string;
  connection: { remoteAddress: string | null; localPort: number | null };
  hasForwardingHeaders: boolean;
}): boolean {
  const { origin, connection } = input;
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return false;
  }
  const isLoopbackPeer =
    connection.remoteAddress !== null &&
    (connection.remoteAddress === "::1" ||
      connection.remoteAddress.startsWith("127.") ||
      connection.remoteAddress.startsWith("::ffff:127."));
  const isDirectLoopbackHost =
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1");
  return isDirectLoopbackHost
    ? isLoopbackPeer &&
        !input.hasForwardingHeaders &&
        connection.localPort !== null &&
        origin.origin === new URL(`http://${origin.hostname}:${connection.localPort}`).origin
    : origin.origin === input.publicOrigin;
}
