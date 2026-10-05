import { expect, test } from "vitest";

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { provisionGraftControlDatabase } from "./graft-control-database";
import { GraftControlStore } from "./graft-control-store";
import { createSqlitePragmaGraftDatabaseOperations } from "./graft-database-operations";
import { provisionGraftObject, type GraftProvisionObjectResult } from "./graft-object-provisioning";

const executeFile = promisify(execFile);
const provisioningProcessFixture = new URL(
  "../testing/fixtures/graft-object-provisioning-process.ts",
  import.meta.url,
);

test("provisioning registers one canonical object database and selects one concurrent winner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-object-provisioning-"));
  const remoteDirectory = path.join(directory, "remote");
  const cacheDirectory = path.join(directory, "cache");
  const configPath = path.join(directory, "graft.toml");
  await Promise.all([mkdir(remoteDirectory), mkdir(cacheDirectory)]);
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

  try {
    const storage = {
      configPath,
      controlRemoteLogId: provisionGraftControlDatabase(configPath),
    };
    const controlStore = new GraftControlStore(storage);
    try {
      const first = provisionGraftObject({
        objectId: "COUNTER:one",
        storage,
        controlStore,
        clock: { kind: "system" },
        databaseOperations: createSqlitePragmaGraftDatabaseOperations(),
      });
      expect(first).toMatchObject({
        outcome: "registered-candidate",
        location: { objectId: "COUNTER:one" },
      });

      const second = provisionGraftObject({
        objectId: "COUNTER:one",
        storage,
        controlStore,
        clock: { kind: "system" },
        databaseOperations: createSqlitePragmaGraftDatabaseOperations(),
      });
      expect(second).toEqual({
        outcome: "already-registered",
        location: first.location,
      });
      expect(controlStore.readObjectLocations()).toEqual([first.location]);

      const barrierDirectory = path.join(directory, "barrier");
      await mkdir(barrierDirectory);
      const contenderAConfigPath = await writeGraftConfig(
        directory,
        "contender-a",
        remoteDirectory,
      );
      const contenderBConfigPath = await writeGraftConfig(
        directory,
        "contender-b",
        remoteDirectory,
      );
      const contenderA = runProvisioningProcess({
        configPath: contenderAConfigPath,
        controlRemoteLogId: storage.controlRemoteLogId,
        objectId: "COUNTER:concurrent",
        barrierDirectory,
        contenderName: "contender-a",
      });
      const contenderB = runProvisioningProcess({
        configPath: contenderBConfigPath,
        controlRemoteLogId: storage.controlRemoteLogId,
        objectId: "COUNTER:concurrent",
        barrierDirectory,
        contenderName: "contender-b",
      });
      await Promise.all([
        waitForPath(path.join(barrierDirectory, "contender-a.ready")),
        waitForPath(path.join(barrierDirectory, "contender-b.ready")),
      ]);
      await writeFile(path.join(barrierDirectory, "release"), "release\n");
      const results = await Promise.all([contenderA, contenderB]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "registered-candidate",
        "used-concurrent-winner",
      ]);
      const registered = results.find((result) => result.outcome === "registered-candidate");
      const concurrentWinner = results.find(
        (result) => result.outcome === "used-concurrent-winner",
      );
      if (!registered || !concurrentWinner) {
        throw new Error("GRAFT_OBJECT_PROVISIONING_CONCURRENT_RESULT_MISSING");
      }
      expect(registered.location).toEqual(concurrentWinner.location);
      expect(concurrentWinner.unusedCandidateRemoteLogId).not.toBe(
        concurrentWinner.location.remoteLogId,
      );
      expect(controlStore.readObjectLocation("COUNTER:concurrent")).toEqual(registered.location);
    } finally {
      controlStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeGraftConfig(
  directory: string,
  name: string,
  remoteDirectory: string,
): Promise<string> {
  const cacheDirectory = path.join(directory, `${name}-cache`);
  await mkdir(cacheDirectory);
  const configPath = path.join(directory, `${name}.toml`);
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

async function runProvisioningProcess(options: {
  configPath: string;
  controlRemoteLogId: string;
  objectId: string;
  barrierDirectory: string;
  contenderName: string;
}): Promise<GraftProvisionObjectResult> {
  const { stdout } = await executeFile(
    process.execPath,
    [
      provisioningProcessFixture.pathname,
      options.configPath,
      options.controlRemoteLogId,
      options.objectId,
      options.barrierDirectory,
      options.contenderName,
    ],
    {
      cwd: path.dirname(provisioningProcessFixture.pathname),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("GRAFT_OBJECT_PROVISIONING_RESULT:"));
  if (!line) {
    throw new Error(`GRAFT_OBJECT_PROVISIONING_PROCESS_RESULT_MISSING:${stdout}`);
  }
  return JSON.parse(
    line.slice("GRAFT_OBJECT_PROVISIONING_RESULT:".length),
  ) as GraftProvisionObjectResult;
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`GRAFT_OBJECT_PROVISIONING_BARRIER_TIMEOUT:${filePath}`);
}
