import { assert, baseUrl, runId } from "./smoke-support.js";

const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000);

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function expectStatus(label, result, expectedStatus) {
  assert(
    result.status === expectedStatus,
    `${label}: expected HTTP ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
}

function expectCode(label, result, expectedCode) {
  assert(
    result.body?.code === expectedCode,
    `${label}: expected code ${expectedCode}, got ${JSON.stringify(result.body)}`,
  );
}

async function main() {
  const prefix = runId("api");
  console.log(`[api-route-validation] baseUrl=${baseUrl} prefix=${prefix}`);

  const workflowList = await request("/");
  expectStatus("workflow list", workflowList, 200);
  const workflowNames = workflowList.body?.workflows?.map((workflow) => workflow.name) ?? [];
  for (const expected of [
    "approval-workflow",
    "demo-data-workflow",
    "parallel-steps-workflow",
    "wait-timeout-workflow",
    "crash-test-workflow",
  ]) {
    assert(workflowNames.includes(expected), `workflow list missing ${expected}`);
  }

  const unknownWorkflowCreate = await request("/missing-workflow/instances", {
    method: "POST",
    body: JSON.stringify({ id: `${prefix}_missing`, params: {} }),
  });
  expectStatus("unknown workflow create", unknownWorkflowCreate, 404);
  expectCode("unknown workflow create", unknownWorkflowCreate, "WORKFLOW_NOT_FOUND");

  const invalidCreateId = await request("/approval-workflow/instances", {
    method: "POST",
    body: JSON.stringify({
      id: "bad/slash",
      params: { requestId: "r", amount: 1, requestedBy: "api" },
    }),
  });
  expectStatus("invalid create id", invalidCreateId, 400);
  console.log(
    `[api-route-validation] invalid create id response ${invalidCreateId.status}: ${JSON.stringify(invalidCreateId.body)}`,
  );
  assert(
    ["INVALID_INSTANCE_ID", "FRAGNO_VALIDATION_ERROR"].includes(invalidCreateId.body?.code),
    `invalid create id: expected INVALID_INSTANCE_ID or FRAGNO_VALIDATION_ERROR, got ${JSON.stringify(invalidCreateId.body)}`,
  );

  const invalidParams = await request("/approval-workflow/instances", {
    method: "POST",
    body: JSON.stringify({ id: `${prefix}_bad_params`, params: { requestId: "r" } }),
  });
  console.log(
    `[api-route-validation] structurally incomplete approval params response ${invalidParams.status}: ${JSON.stringify(invalidParams.body)}`,
  );
  assert(invalidParams.status !== 500, "structurally incomplete params should not return 500");

  const duplicateBatchId = `${prefix}_batch_dup`;
  const duplicateBatch = await request("/approval-workflow/instances/batch", {
    method: "POST",
    body: JSON.stringify({
      instances: [
        {
          id: duplicateBatchId,
          params: { requestId: "r1", amount: 1, requestedBy: "api" },
        },
        {
          id: duplicateBatchId,
          params: { requestId: "r2", amount: 2, requestedBy: "api" },
        },
      ],
    }),
  });
  console.log(
    `[api-route-validation] duplicate batch response ${duplicateBatch.status}: ${JSON.stringify(duplicateBatch.body)}`,
  );
  assert(duplicateBatch.status !== 500, "duplicate IDs inside one batch should not return 500");

  const missingEventType = await request(`/approval-workflow/instances/${prefix}_none/events`, {
    method: "POST",
    body: JSON.stringify({ payload: {} }),
  });
  console.log(
    `[api-route-validation] missing event type response ${missingEventType.status}: ${JSON.stringify(missingEventType.body)}`,
  );
  assert(missingEventType.status !== 500, "missing event type should not return 500");

  const unknownWorkflowEvent = await request("/missing-workflow/instances/id/events", {
    method: "POST",
    body: JSON.stringify({ type: "approval", payload: {} }),
  });
  expectStatus("unknown workflow event", unknownWorkflowEvent, 404);
  expectCode("unknown workflow event", unknownWorkflowEvent, "WORKFLOW_NOT_FOUND");

  console.log("[api-route-validation] completed");
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
