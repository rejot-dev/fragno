import {
  assert,
  baseUrl,
  createInstance,
  pauseInstance,
  requestNoThrow,
  resumeInstance,
  runId,
  sendEvent,
} from "./smoke-support.js";

const count = Number(process.env.COUNT ?? 30);

function summarize(label, results, allowedStatuses = [200, 409]) {
  const ok = results.filter((result) => result.status === undefined);
  const acceptedErrors = results.filter((result) => allowedStatuses.includes(result.status));
  const unexpected = results.filter(
    (result) => result.status !== undefined && !allowedStatuses.includes(result.status),
  );
  console.log(
    `${label}: ok=${ok.length} acceptedErrors=${acceptedErrors.length} unexpected=${unexpected.length}`,
  );
  assert(
    unexpected.length === 0,
    `${label} unexpected errors: ${JSON.stringify(unexpected.slice(0, 5))}`,
  );
}

async function capture(id, action) {
  try {
    await action();
    return { id };
  } catch (error) {
    return { id, status: error.status, body: error.body ?? error.message };
  }
}

async function main() {
  assert(Number.isFinite(count) && count > 0, `Invalid COUNT: ${count}`);
  const prefix = runId("concurrency");
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${index}`);

  console.log(`[auth-hook-concurrency] baseUrl=${baseUrl}`);
  console.log(
    "Note: current wf-example has no authorization hook; this script now checks management concurrency only.",
  );

  const createResults = await Promise.all(
    ids.map((id) =>
      capture(id, () =>
        createInstance("approval-workflow", id, {
          requestId: `req_${id}`,
          amount: 100,
          requestedBy: "concurrency-test",
        }),
      ),
    ),
  );
  summarize("create", createResults, [409]);

  const createdIds = createResults
    .filter((result) => result.status === undefined)
    .map((result) => result.id);
  const pauseResults = await Promise.all(
    createdIds.map((id) => capture(id, () => pauseInstance("approval-workflow", id))),
  );
  summarize("pause", pauseResults, [409]);

  const resumeResults = await Promise.all(
    createdIds.map((id) => capture(id, () => resumeInstance("approval-workflow", id))),
  );
  summarize("resume", resumeResults, [409]);

  const approvalResults = await Promise.all(
    createdIds.map((id) =>
      capture(id, () =>
        sendEvent("approval-workflow", id, "approval", {
          approved: true,
          approver: "concurrency-test",
        }),
      ),
    ),
  );
  summarize("approval", approvalResults, [409]);

  const fulfillmentResults = await Promise.all(
    createdIds.map((id) =>
      capture(id, () =>
        sendEvent("approval-workflow", id, "fulfillment", { confirmationId: `conf_${id}` }),
      ),
    ),
  );
  summarize("fulfillment", fulfillmentResults, [409]);

  // Exercise public 404 response shape without failing the run.
  await requestNoThrow(`/approval-workflow/instances/${prefix}_missing`);

  console.log(`[auth-hook-concurrency] complete created=${createdIds.length}`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
