import {
  assert,
  assertEqual,
  baseUrl,
  createBatch,
  getHistory,
  listInstances,
  runId,
  sendEvent,
  waitForTerminal,
  waitForWaitEvent,
} from "./smoke-support.js";

const pageSize = Number(process.env.PAGE_SIZE ?? 2);
const instanceCount = Number(process.env.INSTANCE_COUNT ?? 7);

async function collectInstancePages(workflowName, status) {
  const ids = [];
  const seenCursors = new Set();
  let cursor;
  let page = 0;
  do {
    const response = await listInstances(workflowName, { status, pageSize, cursor });
    page += 1;
    for (const instance of response.instances) {
      ids.push(instance.id);
    }
    if (response.hasNextPage) {
      assert(response.nextCursor, `page ${page} hasNextPage=true without cursor`);
      assert(!seenCursors.has(response.nextCursor), `cursor repeated on page ${page}`);
      seenCursors.add(response.nextCursor);
    }
    cursor = response.hasNextPage ? response.nextCursor : undefined;
  } while (cursor);
  return ids;
}

async function main() {
  assert(Number.isFinite(pageSize) && pageSize > 0, `Invalid PAGE_SIZE: ${pageSize}`);
  assert(
    Number.isFinite(instanceCount) && instanceCount >= pageSize + 1,
    `Invalid INSTANCE_COUNT: ${instanceCount}`,
  );

  const prefix = runId("page");
  const ids = Array.from({ length: instanceCount }, (_, index) => `${prefix}_${index}`);
  console.log(`[history-pagination] baseUrl=${baseUrl} creating ${ids.length} instances`);

  const batch = await createBatch(
    "approval-workflow",
    ids.map((id) => ({
      id,
      params: { requestId: `req_${id}`, amount: 10, requestedBy: "pagination" },
    })),
  );
  assertEqual("created batch size", batch.instances.length, ids.length);

  await Promise.all(
    ids.map(async (id) => {
      await waitForWaitEvent("approval-workflow", id, "approval");
      await sendEvent("approval-workflow", id, "approval", {
        approved: true,
        approver: "pagination",
      });
      await waitForWaitEvent("approval-workflow", id, "fulfillment", { timeoutMs: 30_000 });
      await sendEvent("approval-workflow", id, "fulfillment", { confirmationId: `conf_${id}` });
      await waitForTerminal("approval-workflow", id, { timeoutMs: 30_000 });
    }),
  );

  const failed = [];
  for (const id of ids) {
    const history = await getHistory("approval-workflow", id);
    const eventTypes = history.events.map((event) => event.type);
    const stepKeys = history.steps.map((step) => step.stepKey);
    if (!eventTypes.includes("approval") || !eventTypes.includes("fulfillment")) {
      failed.push(`${id}: missing approval/fulfillment event`);
    }
    if (
      !stepKeys.some((key) => key.includes("approval")) ||
      !stepKeys.some((key) => key.includes("fulfillment"))
    ) {
      failed.push(`${id}: missing approval/fulfillment step`);
    }
  }

  const completedIds = await collectInstancePages("approval-workflow", "complete");
  for (const id of ids) {
    assert(completedIds.includes(id), `completed instance ${id} missing from paginated list`);
  }

  assert(failed.length === 0, `History validation failures:\n${failed.join("\n")}`);
  console.log(`[history-pagination] complete pages covered ${ids.length} ids`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
