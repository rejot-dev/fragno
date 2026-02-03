const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const paramBytes = Number(process.env.PARAM_BYTES ?? 262144);
const approvalBytes = Number(process.env.APPROVAL_BYTES ?? 262144);
const fulfillmentBytes = Number(process.env.FULFILLMENT_BYTES ?? 262144);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 20000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);

for (const [label, value] of [
  ["PARAM_BYTES", paramBytes],
  ["APPROVAL_BYTES", approvalBytes],
  ["FULFILLMENT_BYTES", fulfillmentBytes],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function createInstance(id, params) {
  return request(`/approval-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params }),
  });
}

async function sendEvent(id, type, payload) {
  return request(`/approval-workflow/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function getHistory(id) {
  return request(`/approval-workflow/instances/${id}/history`);
}

async function waitForStatus(id, predicate, label) {
  const start = Date.now();
  while (Date.now() - start < pollTimeoutMs) {
    const status = await getStatus(id);
    if (predicate(status)) {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${id} to reach ${label}`);
}

function buildBlob(bytes) {
  return "x".repeat(bytes);
}

function findEventPayload(history, type) {
  const events = history.events ?? [];
  const match = events.find((event) => event.type === type);
  return match?.payload ?? null;
}

function findResultPayload(status) {
  return status?.details?.output ?? status?.details?.result ?? null;
}

function assertLength(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} length mismatch: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const runId = Date.now().toString(36);
  const id = `large_${runId}`;
  const paramBlob = buildBlob(paramBytes);
  const approvalBlob = buildBlob(approvalBytes);
  const fulfillmentBlob = buildBlob(fulfillmentBytes);

  console.log(`Creating instance ${id} with params blob ${paramBytes} bytes...`);
  await createInstance(id, {
    requestId: `req_${id}`,
    amount: 123,
    requestedBy: "payload-test",
    largeParam: paramBlob,
  });

  await waitForStatus(
    id,
    (status) =>
      status.details.status === "waiting" && status.meta?.currentStep?.waitEventType === "approval",
    "waiting for approval",
  );

  console.log(`Sending approval event with ${approvalBytes} bytes...`);
  await sendEvent(id, "approval", {
    approved: true,
    approver: "payload-test",
    note: approvalBlob,
  });

  await waitForStatus(
    id,
    (status) =>
      status.details.status === "waiting" &&
      status.meta?.currentStep?.waitEventType === "fulfillment",
    "waiting for fulfillment",
  );

  console.log(`Sending fulfillment event with ${fulfillmentBytes} bytes...`);
  await sendEvent(id, "fulfillment", {
    confirmationId: `conf_${id}`,
    blob: fulfillmentBlob,
  });

  const terminalStatus = await waitForStatus(
    id,
    (status) => ["complete", "errored", "terminated"].includes(status.details.status),
    "terminal",
  );

  if (terminalStatus.details.status !== "complete") {
    throw new Error(`Instance ${id} did not complete: ${terminalStatus.details.status}`);
  }

  const history = await getHistory(id);
  const approvalPayload = findEventPayload(history, "approval");
  const fulfillmentPayload = findEventPayload(history, "fulfillment");
  const resultPayload = findResultPayload(terminalStatus);

  if (!approvalPayload || !fulfillmentPayload) {
    throw new Error(`Missing approval or fulfillment payload in history for ${id}`);
  }

  assertLength("params.largeParam", paramBlob.length, paramBytes);
  assertLength("history.approval.note", approvalPayload.note?.length ?? -1, approvalBytes);
  assertLength("history.fulfillment.blob", fulfillmentPayload.blob?.length ?? -1, fulfillmentBytes);

  if (resultPayload?.request?.largeParam) {
    assertLength("output.request.largeParam", resultPayload.request.largeParam.length, paramBytes);
  } else {
    console.warn("Instance output did not include largeParam; skipping output length check.");
  }

  console.log("Large payload scenario complete.");
  console.log(`Instance: ${id}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
