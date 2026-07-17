import {
  assert,
  assertEqual,
  assertNoAttemptOverflow,
  baseUrl,
  createInstance,
  getHistory,
  runId,
  sendEvent,
  waitForTerminal,
  waitForWaitEvent,
} from "./smoke-support.js";

const count = Number(process.env.COUNT ?? 12);
const eventStormCount = Number(process.env.EVENT_STORM_COUNT ?? 8);

async function main() {
  assert(Number.isFinite(count) && count > 0, `Invalid COUNT: ${count}`);
  assert(
    Number.isFinite(eventStormCount) && eventStormCount > 0,
    `Invalid EVENT_STORM_COUNT: ${eventStormCount}`,
  );

  const prefix = runId("hookstorm");
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
  console.log(`[runner-tick-storm] baseUrl=${baseUrl} creating ${ids.length} instances`);

  await Promise.all(
    ids.map((id) =>
      createInstance("approval-workflow", id, {
        requestId: `req_${id}`,
        amount: 25,
        requestedBy: "hook-storm",
      }),
    ),
  );

  await Promise.all(ids.map((id) => waitForWaitEvent("approval-workflow", id, "approval")));

  console.log(
    `[runner-tick-storm] sending ${eventStormCount} duplicate approval hooks per instance`,
  );
  await Promise.all(
    ids.flatMap((id) =>
      Array.from({ length: eventStormCount }, (_, index) =>
        sendEvent("approval-workflow", id, "approval", {
          approved: true,
          approver: "hook-storm",
          index,
        }),
      ),
    ),
  );

  await Promise.all(
    ids.map(async (id) => {
      await waitForWaitEvent("approval-workflow", id, "fulfillment", { timeoutMs: 30_000 });
      await Promise.all(
        Array.from({ length: eventStormCount }, (_, index) =>
          sendEvent("approval-workflow", id, "fulfillment", {
            confirmationId: `conf_${id}_${index}`,
          }),
        ),
      );
    }),
  );

  const terminals = await Promise.all(
    ids.map((id) => waitForTerminal("approval-workflow", id, { timeoutMs: 30_000 })),
  );
  const nonComplete = terminals.filter((status) => status.details.status !== "complete");
  assertEqual("non-complete terminals", nonComplete.length, 0);

  for (const id of ids) {
    const history = await getHistory("approval-workflow", id);
    assertNoAttemptOverflow(history, id);
    const consumedApproval = history.events.filter(
      (event) => event.type === "approval" && event.consumedByStepKey,
    ).length;
    const consumedFulfillment = history.events.filter(
      (event) => event.type === "fulfillment" && event.consumedByStepKey,
    ).length;
    assertEqual(`${id} consumed approval`, consumedApproval, 1);
    assertEqual(`${id} consumed fulfillment`, consumedFulfillment, 1);
  }

  console.log(`[runner-tick-storm] complete instances=${ids.length}`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
