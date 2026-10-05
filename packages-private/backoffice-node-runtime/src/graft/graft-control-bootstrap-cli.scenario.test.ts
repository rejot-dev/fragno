import { test } from "vitest";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cliPath = new URL("../../bin/run.js", import.meta.url).pathname;

test("reserves and publishes one control history across total cache loss", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-runtime-bootstrap-cli-"));
  const remoteDirectory = path.join(root, "remote");
  try {
    await mkdir(remoteDirectory, { recursive: true });
    const reserveConfigPath = await writeScenarioGraftConfig(root, "reserve", remoteDirectory);
    const reserved = await runBackofficeNodeRuntimeCli([
      "bootstrap",
      "reserve",
      "--graft-config",
      reserveConfigPath,
    ]);
    assert.equal(reserved.code, 0, reserved.stderr);
    const reservationLine = reserved.stdout
      .split("\n")
      .find((line) => line.startsWith("GRAFT_CONTROL_REMOTE_LOG_RESERVED:"));
    assert.ok(reservationLine);
    const reservation = JSON.parse(
      reservationLine.slice("GRAFT_CONTROL_REMOTE_LOG_RESERVED:".length),
    ) as { controlRemoteLogId: string };

    await rm(path.join(root, "reserve"), { recursive: true, force: true });
    const publishConfigPath = await writeScenarioGraftConfig(root, "publish", remoteDirectory);
    const published = await runBackofficeNodeRuntimeCli([
      "bootstrap",
      "publish",
      "--graft-config",
      publishConfigPath,
      "--control-remote-log-id",
      reservation.controlRemoteLogId,
    ]);
    assert.equal(published.code, 0, published.stderr);
    assert.ok(
      published.stdout.includes(`"controlRemoteLogId":"${reservation.controlRemoteLogId}"`),
    );

    await rm(path.join(root, "publish"), { recursive: true, force: true });
    const verifyConfigPath = await writeScenarioGraftConfig(root, "verify", remoteDirectory);
    const verified = await runBackofficeNodeRuntimeCli([
      "bootstrap",
      "publish",
      "--graft-config",
      verifyConfigPath,
      `--control-remote-log-id=${reservation.controlRemoteLogId}`,
    ]);
    assert.equal(verified.code, 0, verified.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects publish without a reserved control log identity", async () => {
  const result = await runBackofficeNodeRuntimeCli(["bootstrap", "publish"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BACKOFFICE_NODE_RUNTIME_CLI_CONTROL_LOG_ID_REQUIRED/);
});

async function writeScenarioGraftConfig(
  root: string,
  cacheName: string,
  remoteDirectory: string,
): Promise<string> {
  const cacheDirectory = path.join(root, cacheName);
  await mkdir(cacheDirectory, { recursive: true });
  const configPath = path.join(cacheDirectory, "graft.toml");
  await writeFile(
    configPath,
    [
      `data_dir = ${JSON.stringify(cacheDirectory)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(remoteDirectory)}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

async function runBackofficeNodeRuntimeCli(
  arguments_: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...arguments_], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
