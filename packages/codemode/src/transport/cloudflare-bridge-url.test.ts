import { assert, test } from "vitest";

import {
  createCloudflareBridgeHttpUrl,
  createCloudflareBridgeWebSocketUrl,
} from "./cloudflare-bridge-url";

test("the canonical HTTPS Cloudflare bridge origin resolves HTTP and WebSocket routes", () => {
  assert.equal(
    createCloudflareBridgeHttpUrl("https://bridge.example.com/", "/v1/codemode/type-check-files")
      .href,
    "https://bridge.example.com/v1/codemode/type-check-files",
  );
  assert.equal(
    createCloudflareBridgeWebSocketUrl("https://bridge.example.com/", "/v1/codemode/execute").href,
    "wss://bridge.example.com/v1/codemode/execute",
  );
});

test("local HTTP Cloudflare bridge origins resolve local WebSocket routes", () => {
  assert.equal(
    createCloudflareBridgeWebSocketUrl("http://127.0.0.1:8787/", "/v1/codemode/execute").href,
    "ws://127.0.0.1:8787/v1/codemode/execute",
  );
});

test("WebSocket URLs are rejected as non-canonical Cloudflare bridge origins", () => {
  assert.throws(
    () => createCloudflareBridgeWebSocketUrl("wss://bridge.example.com/", "/v1/codemode/execute"),
    /Cloudflare bridge URL must be an https:\/\/ origin/,
  );
});
