import { afterEach, assert, describe, expect, test } from "vitest";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  fetchBackofficeWithoutRedirect,
  resolveSameOriginBackofficeEndpoint,
  resolveSecureBackofficeBaseUrl,
} from "./backoffice-server-url.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
    ),
  );
});

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("secure Backoffice server URLs", () => {
  test.each([
    ["https://backoffice.example", "https://backoffice.example"],
    ["https://backoffice.example:8443/", "https://backoffice.example:8443"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://workspace.localhost:5173", "http://workspace.localhost:5173"],
    ["http://127.12.34.56:5173", "http://127.12.34.56:5173"],
    ["http://[::1]:5173", "http://[::1]:5173"],
  ])("accepts %s", (input, expected) => {
    assert.equal(resolveSecureBackofficeBaseUrl(input), expected);
  });

  test.each([
    "http://backoffice.example",
    "ftp://backoffice.example",
    "https://user:password@backoffice.example",
    "https://backoffice.example/subpath",
    "https://backoffice.example?tenant=one",
    "https://backoffice.example#fragment",
  ])("rejects unsafe server URL %s", (input) => {
    expect(() => resolveSecureBackofficeBaseUrl(input)).toThrow("Backoffice server URL");
  });

  test("requires OAuth endpoints to remain on the selected origin", () => {
    assert.equal(
      resolveSameOriginBackofficeEndpoint({
        baseUrl: "https://backoffice.example",
        endpoint: "https://backoffice.example/api/auth/oauth2/token",
        label: "OAuth token endpoint",
      }),
      "https://backoffice.example/api/auth/oauth2/token",
    );
    expect(() =>
      resolveSameOriginBackofficeEndpoint({
        baseUrl: "https://backoffice.example",
        endpoint: "https://credentials.example/token",
        label: "OAuth token endpoint",
      }),
    ).toThrow("must use the selected Backoffice origin");
  });

  test("does not follow redirects", async () => {
    let redirectedRequestCount = 0;
    const targetBaseUrl = await listenOnLoopback(
      createServer((_request, response) => {
        redirectedRequestCount += 1;
        response.end("redirected");
      }),
    );
    const sourceBaseUrl = await listenOnLoopback(
      createServer((_request, response) => {
        response.writeHead(302, { location: `${targetBaseUrl}/credential-target` });
        response.end();
      }),
    );

    const response = await fetchBackofficeWithoutRedirect(`${sourceBaseUrl}/start`, {});

    assert.equal(response.status, 302);
    assert.equal(redirectedRequestCount, 0);
  });
});
