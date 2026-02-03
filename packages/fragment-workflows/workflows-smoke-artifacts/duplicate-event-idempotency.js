const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 5);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 15000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);
const dupCount = Number(process.env.DUP_COUNT ?? 3);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
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

async function createInstance(id) {
  return request(`/approval-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({
      id,
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "dup" },
    }),
  });
}

async function pauseInstance(id) {
  return request(`/approval-workflow/instances/${id}/pause`, { method: "POST" });
}

async function resumeInstance(id) {
  return request(`/approval-workflow/instances/${id}/resume`, { method: "POST" });
}

async function restartInstance(id) {
  return request(`/approval-workflow/instances/${id}/restart`, { method: "POST" });
}

async function sendEventAllowTerminal(id, type, payload) {
  const response = await fetch(`${baseUrl}/approval-workflow/instances/${id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  if (response.ok) {
    return response.json();
  }
  if (response.status === 409) {
    const text = await response.text();
    if (text.includes("INSTANCE_TERMINAL")) {
      return null;
    }
  }
  const text = await response.text();
  throw new Error(`POST /approval-workflow/instances/${id}/events -> ${response.status}: ${text}`);
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

function analyzeHistory(history) {
  const steps = history.steps ?? [];
  const events = history.events ?? [];
  const approvalSteps = steps.filter((s) => s.stepKey === "approval");
  const fulfillmentSteps = steps.filter((s) => s.stepKey === "fulfillment");
  const approvalConsumed = events.filter((e) => e.consumedByStepKey === "approval");
  const fulfillmentConsumed = events.filter((e) => e.consumedByStepKey === "fulfillment");
  return {
    approvalSteps,
    fulfillmentSteps,
    approvalConsumed,
    fulfillmentConsumed,
  };
}

async function sendDuplicateEvents(id, type, payload) {
  const sends = Array.from({ length: dupCount }, () => sendEventAllowTerminal(id, type, payload));
  const results = await Promise.allSettled(sends);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) {
    const reason = failures[0].reason?.message ?? failures[0].reason;
    throw new Error(`Duplicate event send failed (${type}) for ${id}: ${reason}`);
  }
}

async function runInstance(id) {
  await createInstance(id);

  await pauseInstance(id);
  await sendDuplicateEvents(id, "approval", { approved: true, approver: "dup" });
  await sleep(800);

  const pausedStatus = await getStatus(id);
  if (!["paused", "waitingForPause"].includes(pausedStatus.details.status)) {
    throw new Error(
      `Instance ${id} progressed while paused: ${pausedStatus.details.status} (${pausedStatus.meta?.currentStep?.waitEventType ?? "step"})`,
    );
  }

  await resumeInstance(id);
  await sendDuplicateEvents(id, "approval", { approved: true, approver: "dup" });

  await waitForStatus(
    id,
    (status) =>
      status.details.status === "waiting" &&
      status.meta?.currentStep?.waitEventType === "fulfillment",
    "waiting for fulfillment",
  );

  await sendDuplicateEvents(id, "fulfillment", { confirmationId: `conf_${id}` });

  await waitForStatus(
    id,
    (status) => ["complete", "errored", "terminated"].includes(status.details.status),
    "terminal",
  );

  const history = await getHistory(id);
  const analysis = analyzeHistory(history);
  return { history, analysis };
}

async function runRestartPhase(id) {
  await restartInstance(id);
  await waitForStatus(
    id,
    (status) => status.meta?.runNumber >= 1 && status.details.status === "waiting",
    "restarted waiting",
  );

  await sendDuplicateEvents(id, "approval", { approved: true, approver: "dup" });
  await waitForStatus(
    id,
    (status) =>
      status.details.status === "waiting" &&
      status.meta?.currentStep?.waitEventType === "fulfillment",
    "waiting for fulfillment after restart",
  );
  await sendDuplicateEvents(id, "fulfillment", { confirmationId: `conf_${id}_r1` });
  await waitForStatus(
    id,
    (status) => ["complete", "errored", "terminated"].includes(status.details.status),
    "terminal after restart",
  );

  const history = await getHistory(id);
  const analysis = analyzeHistory(history);
  return { history, analysis };
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `dup_${runId}_${i}`);
  const failures = [];

  for (const id of ids) {
    console.log(`Running duplicate-event idempotency scenario for ${id}...`);
    try {
      const first = await runInstance(id);
      const approvalConsumedCount = first.analysis.approvalConsumed.length;
      const fulfillmentConsumedCount = first.analysis.fulfillmentConsumed.length;
      if (approvalConsumedCount !== 1 || fulfillmentConsumedCount !== 1) {
        failures.push({
          id,
          phase: "initial",
          approvalConsumedCount,
          fulfillmentConsumedCount,
          history: first.history,
        });
      }

      const restarted = await runRestartPhase(id);
      const approvalConsumedRestart = restarted.analysis.approvalConsumed.length;
      const fulfillmentConsumedRestart = restarted.analysis.fulfillmentConsumed.length;
      if (approvalConsumedRestart !== 1 || fulfillmentConsumedRestart !== 1) {
        failures.push({
          id,
          phase: "restart",
          approvalConsumedCount: approvalConsumedRestart,
          fulfillmentConsumedCount: fulfillmentConsumedRestart,
          history: restarted.history,
        });
      }
    } catch (error) {
      failures.push({ id, phase: "exception", error: error?.message ?? error });
    }
  }

  if (failures.length) {
    console.error(`Duplicate-event idempotency failures: ${failures.length}`);
    failures.slice(0, 3).forEach((failure) => {
      console.error(`- ${failure.id} (${failure.phase})`);
      if (failure.error) {
        console.error(`  error: ${failure.error}`);
      } else {
        console.error(
          `  approvalConsumed=${failure.approvalConsumedCount}, fulfillmentConsumed=${failure.fulfillmentConsumedCount}`,
        );
      }
    });
    process.exitCode = 1;
    return;
  }

  console.log("Duplicate-event idempotency scenario completed with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
