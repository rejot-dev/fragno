import {
  assert,
  assertEqual,
  baseUrl,
  countConsumedEvents,
  createInstance,
  eventPayloads,
  getHistory,
  pauseInstance,
  resumeInstance,
  runId,
  waitForStatus,
  sendEvent,
  waitForTerminal,
  waitForWaitEvent,
} from "./smoke-support.js";

const duplicateCount = Number(process.env.DUPLICATE_COUNT ?? 5);

async function sendDuplicates(id, type, payloadFactory) {
  const results = await Promise.allSettled(
    Array.from({ length: duplicateCount }, (_, index) =>
      sendEvent("approval-workflow", id, type, payloadFactory(index)),
    ),
  );
  const unexpected = results.filter(
    (result) => result.status === "rejected" && ![409].includes(result.reason?.status),
  );
  assert(unexpected.length === 0, `Unexpected duplicate ${type} errors: ${unexpected.length}`);
  return {
    accepted: results.filter((result) => result.status === "fulfilled").length,
    terminalRejected: results.filter(
      (result) => result.status === "rejected" && result.reason?.status === 409,
    ).length,
  };
}

async function main() {
  const id = runId("dup");
  console.log(`[duplicate-event-idempotency] baseUrl=${baseUrl} instance=${id}`);

  await createInstance("approval-workflow", id, {
    requestId: `req_${id}`,
    amount: 42,
    requestedBy: "duplicate-test",
  });
  await waitForWaitEvent("approval-workflow", id, "approval");

  await pauseInstance("approval-workflow", id);
  await waitForStatus(
    "approval-workflow",
    id,
    (status) => status.details.status === "paused",
    "paused",
  );
  const pausedApprovalSends = await sendDuplicates(id, "approval", (index) => ({
    approved: true,
    approver: "duplicate-test",
    index,
  }));

  const pausedHistory = await getHistory("approval-workflow", id);
  assertEqual("approval consumed while paused", countConsumedEvents(pausedHistory, "approval"), 0);

  await resumeInstance("approval-workflow", id);
  await waitForWaitEvent("approval-workflow", id, "fulfillment", { timeoutMs: 30_000 });

  const lateApprovalSends = await sendDuplicates(id, "approval", (index) => ({
    approved: true,
    approver: "late-duplicate",
    index,
  }));
  const fulfillmentSends = await sendDuplicates(id, "fulfillment", (index) => ({
    confirmationId: `conf_${id}_${index}`,
  }));

  const terminal = await waitForTerminal("approval-workflow", id, { timeoutMs: 30_000 });
  assertEqual("terminal status", terminal.details.status, "complete");

  const history = await getHistory("approval-workflow", id);
  assertEqual("consumed approval events", countConsumedEvents(history, "approval"), 1);
  assertEqual("consumed fulfillment events", countConsumedEvents(history, "fulfillment"), 1);
  const acceptedApprovals = pausedApprovalSends.accepted + lateApprovalSends.accepted;
  const acceptedFulfillments = fulfillmentSends.accepted;
  assert(
    eventPayloads(history, "approval").length >= acceptedApprovals,
    `accepted approval duplicates were not persisted: accepted=${acceptedApprovals}`,
  );
  assert(
    eventPayloads(history, "fulfillment").length >= acceptedFulfillments,
    `accepted fulfillment duplicates were not persisted: accepted=${acceptedFulfillments}`,
  );
  if (fulfillmentSends.terminalRejected) {
    console.warn(
      `[duplicate-event-idempotency] ${fulfillmentSends.terminalRejected} fulfillment duplicate(s) were rejected after terminalization`,
    );
  }

  console.log(`[duplicate-event-idempotency] complete instance=${id}`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
