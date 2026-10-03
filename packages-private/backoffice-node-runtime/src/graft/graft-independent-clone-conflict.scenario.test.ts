import { assert, expect, test } from "vitest";

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const processFixture = new URL("../testing/fixtures/graft-conflict-process.ts", import.meta.url);
const localTag = "independent-conflict-clone";

type GraftConflictProcessInvocation =
  | { command: "provision"; configPath: string }
  | {
      command: "stage";
      configPath: string;
      remoteLogId: string;
      localTag: string;
      writer: string;
    }
  | {
      command: "push" | "read";
      configPath: string;
      remoteLogId: string;
      localTag: string;
    };

type IndependentClone = {
  writer: string;
  configPath: string;
};

test("independent clones reject one conflicting push without merging speculative SQL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-independent-conflict-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);

  try {
    const provision = await runGraftConflictProcess({
      command: "provision",
      configPath: await writeGraftConfig(directory, "provision", remoteDirectory),
    });
    const remoteLogId = readString(provision, "remoteLogId");
    const clones: IndependentClone[] = [
      {
        writer: "writer-a",
        configPath: await writeGraftConfig(directory, "writer-a", remoteDirectory),
      },
      {
        writer: "writer-b",
        configPath: await writeGraftConfig(directory, "writer-b", remoteDirectory),
      },
    ];

    const staged = await Promise.all(
      clones.map((clone) =>
        runGraftConflictProcess({
          command: "stage",
          configPath: clone.configPath,
          remoteLogId,
          localTag,
          writer: clone.writer,
        }),
      ),
    );
    expect(staged.map((result) => readStringArray(result, "rows"))).toEqual([
      ["writer-a"],
      ["writer-b"],
    ]);

    const competingPushes = await Promise.all(
      clones.map(async (clone) => ({
        clone,
        result: await runGraftConflictProcess({
          command: "push",
          configPath: clone.configPath,
          remoteLogId,
          localTag,
        }),
      })),
    );
    const successfulPushes = competingPushes.filter(
      ({ result }) => readPushKind(result) === "succeeded",
    );
    const failedPushes = competingPushes.filter(({ result }) => readPushKind(result) === "failed");

    expect(successfulPushes).toHaveLength(1);
    expect(failedPushes).toHaveLength(1);

    const successfulPush = successfulPushes[0];
    const failedPush = failedPushes[0];
    if (!successfulPush || !failedPush) {
      throw new Error("GRAFT_CONFLICT_SCENARIO_OUTCOME_COUNT_INVALID");
    }

    expect(readStringArray(successfulPush.result, "rows")).toEqual([successfulPush.clone.writer]);
    expect(readStringArray(failedPush.result, "rows")).toEqual([failedPush.clone.writer]);
    expect(readPushError(failedPush.result)).toMatchObject({
      name: "Error",
      code: "ERR_SQLITE_ERROR",
      errcode: 2,
      errstr: "unknown error",
    });
    expect(readPushError(failedPush.result).message).toContain("has diverged from the remote");
    expect(readString(failedPush.result, "status")).toContain(
      "The Volume and the remote have diverged",
    );
    expect(readString(failedPush.result, "status")).toContain(
      "have 1 and 1 different commits each, respectively",
    );

    const repeatedLosingPush = await runGraftConflictProcess({
      command: "push",
      configPath: failedPush.clone.configPath,
      remoteLogId,
      localTag,
    });
    assert.equal(readPushKind(repeatedLosingPush), "failed");
    expect(readPushError(repeatedLosingPush).message).toContain("has diverged from the remote");
    expect(readString(repeatedLosingPush, "status")).toContain(
      "have 1 and 1 different commits each, respectively",
    );
    expect(readStringArray(repeatedLosingPush, "rows")).toEqual([failedPush.clone.writer]);

    const restored = await runGraftConflictProcess({
      command: "read",
      configPath: await writeGraftConfig(directory, "restored", remoteDirectory),
      remoteLogId,
      localTag: "restored-conflict-clone",
    });
    expect(readStringArray(restored, "rows")).toEqual([successfulPush.clone.writer]);
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
  await mkdir(cacheDirectory, { recursive: true });
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

async function runGraftConflictProcess(
  invocation: GraftConflictProcessInvocation,
): Promise<Record<string, unknown>> {
  const arguments_ = [processFixture.pathname, invocation.command, invocation.configPath];
  if (invocation.command !== "provision") {
    arguments_.push(invocation.remoteLogId, invocation.localTag);
  }
  if (invocation.command === "stage") {
    arguments_.push(invocation.writer);
  }
  const { stdout } = await executeFile(process.execPath, arguments_, {
    cwd: path.dirname(processFixture.pathname),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const resultLine = stdout.split("\n").find((line) => line.startsWith("GRAFT_CONFLICT_RESULT:"));
  if (!resultLine) {
    throw new Error(`GRAFT_CONFLICT_PROCESS_RESULT_MISSING:${stdout}`);
  }
  const result = JSON.parse(resultLine.slice("GRAFT_CONFLICT_RESULT:".length)) as unknown;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("GRAFT_CONFLICT_PROCESS_RESULT_INVALID");
  }
  return result as Record<string, unknown>;
}

function readPushKind(result: Record<string, unknown>): string {
  return readString(readRecord(result, "outcome"), "kind");
}

function readPushError(result: Record<string, unknown>): {
  name: string;
  message: string;
  code: string | number | null;
  errcode: string | number | null;
  errstr: string | number | null;
} {
  const outcome = readRecord(result, "outcome");
  return {
    name: readString(outcome, "name"),
    message: readString(outcome, "message"),
    code: readStringOrNumberOrNull(outcome, "code"),
    errcode: readStringOrNumberOrNull(outcome, "errcode"),
    errstr: readStringOrNumberOrNull(outcome, "errstr"),
  };
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GRAFT_CONFLICT_PROCESS_RECORD_MISSING:${key}`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`GRAFT_CONFLICT_PROCESS_STRING_MISSING:${key}`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`GRAFT_CONFLICT_PROCESS_STRING_ARRAY_MISSING:${key}`);
  }
  return value as string[];
}

function readStringOrNumberOrNull(
  record: Record<string, unknown>,
  key: string,
): string | number | null {
  const value = record[key];
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new Error(`GRAFT_CONFLICT_PROCESS_SCALAR_MISSING:${key}`);
}
