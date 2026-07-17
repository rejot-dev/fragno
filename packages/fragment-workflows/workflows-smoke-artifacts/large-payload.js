import {
  assert,
  assertEqual,
  baseUrl,
  buildBlob,
  createInstance,
  eventPayloads,
  getHistory,
  runId,
  sendEvent,
  waitForTerminal,
  waitForWaitEvent,
} from "./smoke-support.js";

const workflowName = process.env.WORKFLOW_NAME ?? "approval-workflow";
const paramBytes = Number(process.env.PARAM_BYTES ?? 262_144);
const approvalBytes = Number(process.env.APPROVAL_BYTES ?? 262_144);
const fulfillmentBytes = Number(process.env.FULFILLMENT_BYTES ?? 262_144);

for (const [label, value] of [
  ["PARAM_BYTES", paramBytes],
  ["APPROVAL_BYTES", approvalBytes],
  ["FULFILLMENT_BYTES", fulfillmentBytes],
]) {
  assert(Number.isFinite(value) && value > 0, `Invalid ${label}: ${value}`);
}

async function main() {
  const id = runId("large");
  const paramBlob = buildBlob(paramBytes, "p");
  const approvalBlob = buildBlob(approvalBytes, "a");
  const fulfillmentBlob = buildBlob(fulfillmentBytes, "f");

  console.log(`[large-payload] baseUrl=${baseUrl} instance=${id}`);
  await createInstance(workflowName, id, {
    requestId: `req_${id}`,
    amount: 123,
    requestedBy: "payload-test",
    largeParam: paramBlob,
  });

  await waitForWaitEvent(workflowName, id, "approval");

  await sendEvent(workflowName, id, "approval", {
    approved: true,
    approver: "payload-test",
    note: approvalBlob,
  });

  await waitForWaitEvent(workflowName, id, "fulfillment", { timeoutMs: 30_000 });

  await sendEvent(workflowName, id, "fulfillment", {
    confirmationId: `conf_${id}`,
    blob: fulfillmentBlob,
  });

  const terminalStatus = await waitForTerminal(workflowName, id, { timeoutMs: 30_000 });
  assertEqual("terminal status", terminalStatus.details.status, "complete");

  const history = await getHistory(workflowName, id);
  const [approvalPayload] = eventPayloads(history, "approval");
  const [fulfillmentPayload] = eventPayloads(history, "fulfillment");
  const output = terminalStatus.details.output;

  assert(approvalPayload, `Missing approval payload in history for ${id}`);
  assert(fulfillmentPayload, `Missing fulfillment payload in history for ${id}`);

  assertEqual("history.approval.note.length", approvalPayload.note?.length ?? -1, approvalBytes);
  assertEqual(
    "history.fulfillment.blob.length",
    fulfillmentPayload.blob?.length ?? -1,
    fulfillmentBytes,
  );
  assertEqual(
    "output.request.largeParam.length",
    output?.request?.largeParam?.length ?? -1,
    paramBytes,
  );
  assertEqual(
    "output.approval.payload.note.length",
    output?.approval?.payload?.note?.length ?? -1,
    approvalBytes,
  );
  assertEqual(
    "output.fulfillment.payload.blob.length",
    output?.fulfillment?.payload?.blob?.length ?? -1,
    fulfillmentBytes,
  );

  console.log(`[large-payload] complete instance=${id}`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
