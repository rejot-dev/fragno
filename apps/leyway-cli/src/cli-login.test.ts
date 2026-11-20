import { assert, expect, it, type TestContext } from "vitest";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(packageDirectory, "bin/run.js");

async function loginServer(onTestFinished: TestContext["onTestFinished"]) {
  const directory = await mkdtemp(join(tmpdir(), "leyway-cli-login-"));
  const authFile = join(directory, "auth.json");
  const pendingFile = `${authFile}.pending`;
  const state = {
    approval: "authorization_pending",
    deviceRequests: 0,
    polls: [] as URLSearchParams[],
    exchangeAvailable: true,
  };
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    response.setHeader("content-type", "application/json");
    const origin = `http://${request.headers.host}`;
    switch (request.url ?? "/") {
      case "/api/auth/ok":
        response.end(JSON.stringify({ ok: true }));
        break;
      case "/api/backoffice/cli-config":
        response.end(
          JSON.stringify({
            clientId: "cli",
            scope: "backoffice offline_access",
            deviceAuthorizationEndpoint: `${origin}/device/code`,
            tokenEndpoint: `${origin}/token`,
            verificationUri: `${origin}/device`,
          }),
        );
        break;
      case "/device/code":
        state.deviceRequests++;
        response.end(
          JSON.stringify({
            device_code: `secret-${state.deviceRequests}`,
            user_code: "ABCD-EFGH",
            verification_uri: `${origin}/device`,
            verification_uri_complete: `${origin}/device?user_code=ABCD-EFGH`,
            expires_in: 600,
            interval: 1,
          }),
        );
        break;
      case "/token":
        state.polls.push(new URLSearchParams(body));
        if (state.approval === "approved") {
          response.end(
            JSON.stringify({
              access_token: "oauth-access",
              refresh_token: "oauth-refresh",
              expires_in: 3600,
            }),
          );
        } else {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: state.approval }));
        }
        break;
      case "/api/backoffice/execution-token":
        if (!state.exchangeAvailable) {
          response.statusCode = 503;
          response.end(JSON.stringify({ message: "Temporarily unavailable" }));
        } else if (request.headers.authorization === "Bearer oauth-access") {
          response.end(
            JSON.stringify({
              accessToken: "execution-token",
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              scope: { kind: "user", userId: "user-1" },
            }),
          );
        } else {
          response.writeHead(401).end("{}");
        }
        break;
      case "/api/backoffice/me":
        if (request.headers.authorization === "Bearer execution-token") {
          response.end(
            JSON.stringify({
              user: { id: "user-1", email: "test@example.com", role: "user", jurisdiction: null },
              activeOrganizationId: null,
              organizations: [],
            }),
          );
        } else {
          response.writeHead(401).end("{}");
        }
        break;
      default:
        response.writeHead(404).end("{}");
    }
  }
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      response.destroy(new Error("Login test server failed", { cause: error }));
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
    await rm(directory, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const child = spawn(process.execPath, [executable, ...args, "--base-url", baseUrl], {
      cwd: packageDirectory,
      env: { ...process.env, LEYWAY_AUTH_FILE: authFile, LEYWAY_OPEN_BROWSER: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const finished = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
    onTestFinished(async () => {
      child.kill("SIGKILL");
      await finished;
    });
    return { child, finished };
  }

  return { state, run, authFile, pendingFile, baseUrl };
}

it("resumes an interrupted CLI wait without requesting a new approval", async ({
  onTestFinished,
}) => {
  const { state, run, authFile, pendingFile, baseUrl } = await loginServer(onTestFinished);
  const started = await run("login", "--start").finished;
  assert.equal(started.code, 0, started.stderr);
  expect(started.stdout).toContain(`${baseUrl}/device?user_code=ABCD-EFGH`);
  expect(started.stdout).toContain(`login --wait --base-url ${baseUrl}`);
  expect(started.stdout).not.toContain("secret-");
  assert.equal(state.polls.length, 0);
  assert.equal((await stat(pendingFile)).mode & 0o777, 0o600);
  const pending = await readFile(pendingFile, "utf8");

  const waiting = run("login", "--wait");
  await expect.poll(() => state.polls.length, { timeout: 5_000 }).toBe(1);
  waiting.child.kill("SIGKILL");
  await waiting.finished;
  assert.equal(await readFile(pendingFile, "utf8"), pending);

  state.approval = "approved";
  const approved = await run("login", "--wait").finished;
  assert.equal(approved.code, 0, approved.stderr);
  expect(approved.stdout).toContain("Authenticated as test@example.com");
  expect(state.polls.map((poll) => poll.get("device_code"))).toEqual(["secret-1", "secret-1"]);
  expect(JSON.parse(await readFile(pendingFile, "utf8"))).toEqual({ servers: {} });
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);

  const scopes = await run("scopes").finished;
  assert.equal(scopes.code, 0, scopes.stderr);
  expect(scopes.stdout).toContain("user:user-1");
  const reused = await run("login", "--start").finished;
  expect(reused.stdout).toContain("Authenticated as test@example.com");
  assert.equal((await run("login", "--wait").finished).code, 0);
  assert.equal(state.deviceRequests, 1);
}, 20_000);

for (const outcome of ["access_denied", "expired_token", "local-expiry"]) {
  it(`ends a pending CLI login on ${outcome} without storing credentials`, async ({
    onTestFinished,
  }) => {
    const { state, run, authFile, pendingFile, baseUrl } = await loginServer(onTestFinished);
    assert.equal((await run("login", "--wait").finished).code, 1);
    assert.equal((await run("login", "--start").finished).code, 0);
    if (outcome === "local-expiry") {
      const pending = JSON.parse(await readFile(pendingFile, "utf8"));
      pending.servers[baseUrl].expiresAt = new Date(0).toISOString();
      await writeFile(pendingFile, JSON.stringify(pending));
    } else {
      state.approval = outcome;
    }
    const ended = await run("login", "--wait").finished;
    assert.equal(ended.code, 1);
    expect(ended.stderr).toContain(outcome === "access_denied" ? "denied" : "expired");
    expect(JSON.parse(await readFile(pendingFile, "utf8"))).toEqual({ servers: {} });
    await expect(stat(authFile)).rejects.toMatchObject({ code: "ENOENT" });
    assert.equal(state.polls.length, outcome === "local-expiry" ? 0 : 1);
  }, 15_000);
}

it("keeps approved tokens when the execution-token exchange fails", async ({ onTestFinished }) => {
  const { state, run, authFile } = await loginServer(onTestFinished);
  assert.equal((await run("login", "--start").finished).code, 0);
  state.approval = "approved";
  state.exchangeAvailable = false;
  const failed = await run("login", "--wait").finished;
  assert.equal(failed.code, 1);
  expect(failed.stderr).toContain("503");
  expect(await readFile(authFile, "utf8")).toContain("oauth-refresh");

  state.exchangeAvailable = true;
  const resumed = await run("login", "--wait").finished;
  assert.equal(resumed.code, 0, resumed.stderr);
  expect(resumed.stdout).toContain("Authenticated as test@example.com");
  assert.equal(state.polls.length, 1);
  assert.equal(state.deviceRequests, 1);
}, 15_000);

it("keeps plain login blocking and --force requests fresh approval", async ({ onTestFinished }) => {
  const { state, run } = await loginServer(onTestFinished);
  const login = run("login");
  await expect.poll(() => state.polls.length, { timeout: 5_000 }).toBe(1);
  state.approval = "approved";
  const approved = await login.finished;
  assert.equal(approved.code, 0, approved.stderr);
  expect(approved.stdout).toContain("Authenticated as test@example.com");
  assert.equal((await run("login", "--start", "--force").finished).code, 0);
  assert.equal(state.deviceRequests, 2);
}, 15_000);
