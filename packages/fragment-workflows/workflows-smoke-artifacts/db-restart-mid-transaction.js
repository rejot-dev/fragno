import { execSync } from "node:child_process";

import {
  assert,
  assertEqual,
  assertNoAttemptOverflow,
  baseUrl,
  createInstance,
  getHistory,
  runId,
  sleep,
  getStatus,
} from "./smoke-support.js";

const count = Number(process.env.COUNT ?? 3);
const waitBeforeRestartMs = Number(process.env.WAIT_BEFORE_RESTART_MS ?? 2_000);
const recoveryTimeoutMs = Number(process.env.RECOVERY_TIMEOUT_MS ?? 60_000);
const restartCommand = process.env.DB_RESTART_COMMAND;

function restartDatabase() {
  if (restartCommand) {
    execSync(restartCommand, { stdio: "inherit", shell: true });
    return;
  }

  const container = process.env.POSTGRES_CONTAINER ?? "fragno-postgres";
  execSync(`docker restart ${container}`, { stdio: "inherit" });
}

async function waitForTerminalResilient(id) {
  const deadline = Date.now() + recoveryTimeoutMs;
  let lastError;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      lastStatus = await getStatus("crash-test-workflow", id);
      if (["complete", "errored", "terminated"].includes(lastStatus.details.status)) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for ${id}; lastStatus=${JSON.stringify(lastStatus)} lastError=${lastError?.message ?? "none"}`,
  );
}

async function main() {
  assert(Number.isFinite(count) && count > 0, `Invalid COUNT: ${count}`);
  const prefix = runId("dbrestart");
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${index}`);

  console.log(
    `[db-restart-mid-transaction] baseUrl=${baseUrl} creating ${ids.length} crash-test instances`,
  );
  await Promise.all(ids.map((id) => createInstance("crash-test-workflow", id, {})));

  console.log(`[db-restart-mid-transaction] waiting ${waitBeforeRestartMs}ms before DB restart`);
  await sleep(waitBeforeRestartMs);
  restartDatabase();

  const terminals = await Promise.all(ids.map((id) => waitForTerminalResilient(id)));
  const nonComplete = terminals.filter((status) => status.details.status !== "complete");
  assertEqual("non-complete terminals", nonComplete.length, 0);

  for (const id of ids) {
    assertNoAttemptOverflow(await getHistory("crash-test-workflow", id), id);
  }

  console.log("[db-restart-mid-transaction] complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
