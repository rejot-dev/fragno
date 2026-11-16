import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPendingDeviceAuthorization,
  type OAuthCredential,
  type PendingDeviceAuthorization,
  readPendingDeviceAuthorization,
  readStoredAuth,
  refreshStoredOAuth,
  storeAuth,
  storeBackofficeCredential,
  storePendingDeviceAuthorization,
  type StoredAuthState,
} from "./auth-store.js";

let directory: string;
let authFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "leyway-auth-store-"));
  authFile = join(directory, "auth.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function signedIn(baseUrl: string, refreshToken: string): StoredAuthState {
  return {
    baseUrl,
    oauth: {
      clientId: "cli",
      accessToken: `access-${refreshToken}`,
      accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
      refreshToken,
    },
    backoffice: {
      accessToken: "jwt",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scope: { kind: "system" },
    },
  };
}

function pendingLogin(deviceCode: string): PendingDeviceAuthorization {
  return {
    clientId: "cli",
    deviceCode,
    intervalSeconds: 5,
    expiresAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("CLI auth store", () => {
  it("keeps every server signed in", async () => {
    await storeAuth(authFile, signedIn("http://127.0.0.1:5911", "local"));
    await storeAuth(authFile, signedIn("https://leyway.com", "cloud"));

    assert.equal(
      (await readStoredAuth(authFile, "http://127.0.0.1:5911"))?.oauth.refreshToken,
      "local",
    );
    assert.equal(
      (await readStoredAuth(authFile, "https://leyway.com"))?.oauth.refreshToken,
      "cloud",
    );
  });

  it("spends a refresh token once when processes refresh at the same time", async () => {
    const baseUrl = "http://127.0.0.1:5911";
    await storeAuth(authFile, signedIn(baseUrl, "r1"));
    const stale = await readStoredAuth(authFile, baseUrl);
    if (!stale) {
      throw new Error("The sign-in was not stored.");
    }
    const spent: string[] = [];
    async function rotate(oauth: OAuthCredential): Promise<OAuthCredential> {
      spent.push(oauth.refreshToken);
      return { ...oauth, accessToken: "access-r2", refreshToken: "r2" };
    }

    const results = await Promise.all([
      refreshStoredOAuth(authFile, stale, rotate),
      refreshStoredOAuth(authFile, stale, rotate),
      refreshStoredOAuth(authFile, stale, rotate),
    ]);

    expect(spent).toEqual(["r1"]);
    expect(results.map((auth) => auth.oauth.refreshToken)).toEqual(["r2", "r2", "r2"]);
    assert.equal((await readStoredAuth(authFile, baseUrl))?.oauth.refreshToken, "r2");
  });

  it("stores a Backoffice token without undoing a refresh another process made", async () => {
    const baseUrl = "http://127.0.0.1:5911";
    await storeAuth(authFile, signedIn(baseUrl, "r1"));
    const stale = signedIn(baseUrl, "r1");
    await refreshStoredOAuth(authFile, stale, async (oauth) => ({ ...oauth, refreshToken: "r2" }));

    await storeBackofficeCredential(authFile, {
      ...stale,
      backoffice: { ...stale.backoffice, accessToken: "new-jwt" },
    });

    const stored = await readStoredAuth(authFile, baseUrl);
    assert.equal(stored?.oauth.refreshToken, "r2");
    assert.equal(stored?.backoffice.accessToken, "new-jwt");
  });

  it("does not wait on a command that was killed while refreshing", async () => {
    const baseUrl = "http://127.0.0.1:5911";
    await storeAuth(authFile, signedIn(baseUrl, "r1"));
    // The child refreshes with a token request that never answers, then dies holding the lock.
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import { readStoredAuth, refreshStoredOAuth } from ${JSON.stringify(new URL("./auth-store.ts", import.meta.url).href)};
          const authFile = ${JSON.stringify(authFile)};
          const auth = await readStoredAuth(authFile, ${JSON.stringify(baseUrl)});
          await refreshStoredOAuth(authFile, auth, () => {
            process.stdout.write("refreshing");
            // Like a pending request's socket, the timer keeps the child alive and holds \`resolve\`.
            // A promise nothing can settle is garbage, and collecting it closes the lock.
            return new Promise((resolve) => setTimeout(resolve, 600_000));
          });
        `,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const waiting = refreshStoredOAuth(authFile, signedIn(baseUrl, "r1"), async (oauth) => ({
        ...oauth,
        refreshToken: `${oauth.refreshToken}-rotated`,
      }));
      let finished = false;
      void waiting.then(() => {
        finished = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      assert.isFalse(finished, "The refresh ran while the child held the lock.");
      child.kill("SIGKILL");
      await exited;

      assert.equal((await waiting).oauth.refreshToken, "r1-rotated");
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("keeps a newer pending login when an older one finishes", async () => {
    const pendingLoginFile = `${authFile}.pending`;
    const baseUrl = "http://127.0.0.1:5911";
    await storePendingDeviceAuthorization(pendingLoginFile, baseUrl, pendingLogin("first"));
    await storePendingDeviceAuthorization(pendingLoginFile, baseUrl, pendingLogin("second"));

    await clearPendingDeviceAuthorization(pendingLoginFile, baseUrl, "first");
    assert.equal(
      (await readPendingDeviceAuthorization(pendingLoginFile, baseUrl))?.deviceCode,
      "second",
    );

    await clearPendingDeviceAuthorization(pendingLoginFile, baseUrl, "second");
    assert.isNull(await readPendingDeviceAuthorization(pendingLoginFile, baseUrl));
  });
});
