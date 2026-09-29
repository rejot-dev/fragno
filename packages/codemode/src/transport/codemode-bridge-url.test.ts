import { assert, test } from "vitest";

import {
  createCodemodeBridgeHttpUrl,
  createCodemodeBridgeWebSocketUrl,
} from "./codemode-bridge-url";

test("the canonical HTTPS bridge origin resolves HTTP and WebSocket routes", () => {
  assert.equal(
    createCodemodeBridgeHttpUrl("https://bridge.example.com/", "/v1/codemode/type-check-files")
      .href,
    "https://bridge.example.com/v1/codemode/type-check-files",
  );
  assert.equal(
    createCodemodeBridgeWebSocketUrl("https://bridge.example.com/", "/v1/codemode/execute").href,
    "wss://bridge.example.com/v1/codemode/execute",
  );
});

test("local HTTP bridge origins resolve local WebSocket routes", () => {
  assert.equal(
    createCodemodeBridgeWebSocketUrl("http://127.0.0.1:8787/", "/v1/codemode/execute").href,
    "ws://127.0.0.1:8787/v1/codemode/execute",
  );
});

test("WebSocket URLs are rejected as non-canonical bridge origins", () => {
  assert.throws(
    () => createCodemodeBridgeWebSocketUrl("wss://bridge.example.com/", "/v1/codemode/execute"),
    /Codemode bridge URL must be an https:\/\/ origin/,
  );
});
