import { expect, test } from "vitest";

import { resolveAuthorizationBrowserLaunch } from "./authorization-browser";

test("Windows browser launch preserves OAuth query parameters without a command shell", () => {
  const authorizationUrl =
    "https://connector.example/authorize?client_id=fragno&redirect_uri=http%3A%2F%2Flocalhost&state=request-1";

  expect(resolveAuthorizationBrowserLaunch("win32", authorizationUrl)).toEqual({
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", authorizationUrl],
  });
});
