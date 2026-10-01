import { afterEach, assert, expect, test } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { startProjectConnectorTestGateway } from "../testing/project-connector-test-gateway";
import { runProjectConnectorCli } from "./cli";

const cleanup: (() => Promise<void>)[] = [];
const originalDataDir = process.env["FRAGNO_DATA_DIR"];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  if (originalDataDir === undefined) {
    delete process.env["FRAGNO_DATA_DIR"];
  } else {
    process.env["FRAGNO_DATA_DIR"] = originalDataDir;
  }
});

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
}

test("CLI check, authorization, profile, and later invocations share verified SQLite bindings", async () => {
  const gateway = await startProjectConnectorTestGateway();
  cleanup.push(gateway.close);
  const directory = await mkdtemp(path.join(tmpdir(), "fragno-project-connector-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, ".env");
  await writeFile(
    envFile,
    `OOMOL_CONNECTOR_BASE_URL=${gateway.baseUrl}\nOOMOL_PROJECT_API_KEY=test-project-key\n`,
    { mode: 0o600 },
  );
  const options = ["--env-file", envFile, "--data-dir", directory, "--user-id", "alice"];
  const output: string[] = [];
  const errors: string[] = [];
  const logger = {
    log: (value: string) => {
      output.push(value);
    },
    error: (value: string) => {
      errors.push(value);
    },
  };
  assert((await runProjectConnectorCli(["check", ...options], logger)) === 0);
  expect(JSON.parse(output.pop()!)).toEqual({ authenticated: true });
  const port = await unusedLoopbackPort();
  const connectorLogger = {
    ...logger,
    log(value: string) {
      output.push(value);
      if (value.startsWith("Connection request: ")) {
        const id = value.split("\n")[0].slice("Connection request: ".length);
        gateway.authorize(id, "cli-gmail-account");
      }
    },
  };
  assert(
    (await runProjectConnectorCli(
      [
        "--",
        "connect",
        "gmail",
        ...options,
        "--port",
        `${port}`,
        "--no-open",
        "--timeout-ms",
        "5000",
      ],
      connectorLogger,
    )) === 0,
  );
  expect(output.join("\n")).toContain("Connected account: cli-gmail-account");
  expect(output.join("\n")).toContain("gmail-user@example.test");
  output.length = 0;
  assert((await runProjectConnectorCli(["accounts", ...options], logger)) === 0);
  expect(JSON.parse(output[0])).toMatchObject({
    id: "cli-gmail-account",
    externalUserId: "alice",
    providerConfigId: "gmail-provider",
  });
  output.length = 0;
  assert(
    (await runProjectConnectorCli(["profile", "cli-gmail-account", ...options], logger)) === 0,
  );
  expect(JSON.parse(output[0])).toMatchObject({
    connectedAccountId: "cli-gmail-account",
    profile: { email: "gmail-user@example.test" },
  });
  assert(
    (await runProjectConnectorCli(
      [
        "execute",
        "cli-gmail-account",
        "gmail.search_threads",
        ...options,
        "--input",
        '{"query":"is:unread"}',
      ],
      logger,
    )) === 0,
  );
  expect(gateway.executions).toEqual([
    {
      externalUserId: "alice",
      providerConfigId: "gmail-provider",
      connectedAccountId: "cli-gmail-account",
      input: { query: "is:unread" },
    },
  ]);
  expect(errors).toEqual([]);
  assert(
    (await runProjectConnectorCli(
      [
        "profile",
        "cli-gmail-account",
        "--env-file",
        envFile,
        "--data-dir",
        directory,
        "--user-id",
        "bob",
      ],
      logger,
    )) === 1,
  );
  expect(errors.pop()).toContain("ACCOUNT_NOT_FOUND");
  // The temporary return server must not outlive a completed authorization.
  await expect(fetch(`http://127.0.0.1:${port}/connected`)).rejects.toThrow();
});

test("CLI fails safely on an invalid key and does not leak it in diagnostics", async () => {
  const gateway = await startProjectConnectorTestGateway();
  cleanup.push(gateway.close);
  const directory = await mkdtemp(path.join(tmpdir(), "fragno-project-connector-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, ".env");
  await writeFile(
    envFile,
    `OOMOL_CONNECTOR_BASE_URL=${gateway.baseUrl}\nOOMOL_PROJECT_API_KEY=invalid-secret-key\n`,
    { mode: 0o600 },
  );
  const errors: string[] = [];
  const logger = {
    log: (_value: string) => undefined,
    error: (value: string) => {
      errors.push(value);
    },
  };
  assert(
    (await runProjectConnectorCli(
      ["check", "--env-file", envFile, "--data-dir", directory],
      logger,
    )) === 1,
  );
  expect(errors.join("\n")).toContain("PROJECT_CONNECTOR_ERROR");
  expect(errors.join("\n")).not.toContain("invalid-secret-key");
  assert(gateway.requests.size === 0);
});
