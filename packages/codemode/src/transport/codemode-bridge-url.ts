function readCodemodeBridgeHttpOrigin(bridgeUrl: string): URL {
  const url = new URL(bridgeUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Codemode bridge URL must be an https:// origin (http:// is allowed only on loopback).",
    );
  }
  return url;
}

/** Resolves an authenticated HTTP route against the canonical Cloudflare bridge origin. */
export function createCodemodeBridgeHttpUrl(bridgeUrl: string, pathname: string): URL {
  const url = readCodemodeBridgeHttpOrigin(bridgeUrl);
  url.pathname = pathname;
  return url;
}

/** Resolves a WebSocket route by upgrading the canonical Cloudflare bridge HTTP origin. */
export function createCodemodeBridgeWebSocketUrl(bridgeUrl: string, pathname: string): URL {
  const url = readCodemodeBridgeHttpOrigin(bridgeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  return url;
}
