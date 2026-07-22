export const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";

export const defaultPollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 20_000);
export const defaultPollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);

export const terminalStatuses = new Set(["complete", "errored", "terminated"]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

export function assertIn(label, actual, expectedValues) {
  if (!expectedValues.includes(actual)) {
    throw new Error(
      `${label} mismatch: expected one of ${expectedValues.join(", ")}, got ${actual}`,
    );
  }
}

export function runId(prefix = "smoke") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildBlob(bytes, char = "x") {
  assert(Number.isFinite(bytes) && bytes >= 0, `Invalid byte length: ${bytes}`);
  return char.repeat(bytes);
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request(path, options = {}) {
  const expectedStatuses = options.expectedStatuses;
  const headers = {
    "content-type": "application/json",
    ...options.headers,
  };
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  const body = await parseResponseBody(response);
  const isExpected = expectedStatuses?.includes(response.status) ?? response.ok;
  if (!isExpected) {
    const rendered = typeof body === "string" ? body : JSON.stringify(body);
    const error = new Error(
      `${options.method ?? "GET"} ${path} -> ${response.status}: ${rendered}`,
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function requestNoThrow(path, options = {}) {
  return request(path, {
    ...options,
    expectedStatuses: [200, 201, 202, 204, 400, 401, 403, 404, 409, 500],
  });
}

export function listWorkflows() {
  return request("/");
}

export function listInstances(workflowName, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return request(`/${workflowName}/instances${suffix}`);
}

export function createInstance(workflowName, id, params = {}) {
  return request(`/${workflowName}/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params }),
  });
}

export function createBatch(workflowName, instances) {
  return request(`/${workflowName}/instances/batch`, {
    method: "POST",
    body: JSON.stringify({ instances }),
  });
}

export function sendEvent(workflowName, id, type, payload) {
  return request(`/${workflowName}/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

export function pauseInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/pause`, { method: "POST" });
}

export function resumeInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/resume`, { method: "POST" });
}

export function terminateInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/terminate`, { method: "POST" });
}

export function getStatus(workflowName, id) {
  return request(`/${workflowName}/instances/${id}`);
}

export function getHistory(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/history`);
}

export function getCurrentStepEmissionsOnce(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/current-step/emissions?once=true`);
}

export async function waitForStatus(workflowName, id, predicate, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? defaultPollTimeoutMs;
  const intervalMs = options.intervalMs ?? defaultPollIntervalMs;
  const start = Date.now();
  let lastStatus;
  while (Date.now() - start < timeoutMs) {
    lastStatus = await getStatus(workflowName, id);
    if (predicate(lastStatus)) {
      return lastStatus;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${workflowName}/${id} to reach ${label}. Last status: ${JSON.stringify(lastStatus)}`,
  );
}

export function waitForTerminal(workflowName, id, options = {}) {
  return waitForStatus(
    workflowName,
    id,
    (status) => terminalStatuses.has(status.details?.status),
    "terminal",
    options,
  );
}

export function waitForCurrentStep(workflowName, id, predicate, label, options = {}) {
  return waitForStatus(
    workflowName,
    id,
    (status) => Boolean(status.meta?.currentStep && predicate(status.meta.currentStep, status)),
    label,
    options,
  );
}

export function waitForWaitEvent(workflowName, id, eventType, options = {}) {
  return waitForCurrentStep(
    workflowName,
    id,
    (step, status) => status.details?.status === "waiting" && step.waitEventType === eventType,
    `waiting for ${eventType}`,
    options,
  );
}

export function countConsumedEvents(history, type) {
  return history.events.filter((event) => event.type === type && event.consumedByStepKey).length;
}

export function eventPayloads(history, type) {
  return history.events.flatMap((event) => (event.type === type ? [event.payload] : []));
}

export function assertNoAttemptOverflow(history, label = "history") {
  const overflow = history.steps.filter((step) => step.attempts > step.maxAttempts);
  assert(
    overflow.length === 0,
    `${label} has steps over maxAttempts: ${overflow.map((step) => `${step.stepKey}:${step.attempts}/${step.maxAttempts}`).join(", ")}`,
  );
}

export async function completeApprovalWorkflow(id, params = {}) {
  await createInstance("approval-workflow", id, {
    requestId: `req_${id}`,
    amount: 50,
    requestedBy: "smoke",
    ...params,
  });
  await waitForWaitEvent("approval-workflow", id, "approval");
  await sendEvent("approval-workflow", id, "approval", { approved: true, approver: "smoke" });
  await waitForWaitEvent("approval-workflow", id, "fulfillment", { timeoutMs: 30_000 });
  await sendEvent("approval-workflow", id, "fulfillment", { confirmationId: `conf_${id}` });
  const terminal = await waitForTerminal("approval-workflow", id, { timeoutMs: 30_000 });
  assertEqual("approval workflow terminal status", terminal.details.status, "complete");
  return terminal;
}
