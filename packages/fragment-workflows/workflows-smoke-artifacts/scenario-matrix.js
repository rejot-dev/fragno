const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const approvalCount = Number(process.env.APPROVAL_COUNT ?? 8);
const parallelCount = Number(process.env.PARALLEL_COUNT ?? 6);
const waitCount = Number(process.env.WAIT_COUNT ?? 6);
const durationMs = Number(process.env.DURATION_MS ?? 20000);
const actionIntervalMs = Number(process.env.ACTION_INTERVAL_MS ?? 250);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 12000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 500);

if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(`Invalid DURATION_MS: ${process.env.DURATION_MS}`);
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

async function createInstance(workflowName, id, params = {}) {
  return request(`/${workflowName}/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params }),
  });
}

async function sendEvent(workflowName, id, type, payload) {
  return request(`/${workflowName}/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function pauseInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/pause`, { method: "POST" });
}

async function resumeInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/resume`, { method: "POST" });
}

async function restartInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/restart`, { method: "POST" });
}

async function terminateInstance(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/terminate`, { method: "POST" });
}

async function getStatus(workflowName, id) {
  return request(`/${workflowName}/instances/${id}`);
}

async function getHistory(workflowName, id) {
  return request(`/${workflowName}/instances/${id}/history`);
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function main() {
  const runId = Date.now().toString(36);
  const approvalIds = Array.from({ length: approvalCount }, (_, i) => `sm_app_${runId}_${i}`);
  const parallelIds = Array.from({ length: parallelCount }, (_, i) => `sm_par_${runId}_${i}`);
  const waitIds = Array.from({ length: waitCount }, (_, i) => `sm_wait_${runId}_${i}`);

  console.log("Creating instances...");
  await Promise.all([
    ...approvalIds.map((id) =>
      createInstance("approval-workflow", id, {
        requestId: `req_${id}`,
        amount: 50,
        requestedBy: "matrix",
      }),
    ),
    ...parallelIds.map((id) => createInstance("parallel-steps-workflow", id, {})),
    ...waitIds.map((id) => createInstance("wait-timeout-workflow", id, {})),
  ]);

  const allApprovalActions = [
    (id) => sendEvent("approval-workflow", id, "approval", { approved: true, approver: "matrix" }),
    (id) => sendEvent("approval-workflow", id, "fulfillment", { confirmationId: `conf_${id}` }),
    (id) => pauseInstance("approval-workflow", id),
    (id) => resumeInstance("approval-workflow", id),
    (id) => restartInstance("approval-workflow", id),
    (id) => terminateInstance("approval-workflow", id),
  ];

  const allParallelActions = [
    (id) => restartInstance("parallel-steps-workflow", id),
    (id) => terminateInstance("parallel-steps-workflow", id),
  ];

  const allWaitActions = [
    (id) => sendEvent("wait-timeout-workflow", id, "edge", { ok: true, source: "matrix" }),
    (id) => restartInstance("wait-timeout-workflow", id),
    (id) => terminateInstance("wait-timeout-workflow", id),
  ];

  console.log("Running randomized actions...");
  const start = Date.now();
  let actionsRun = 0;
  while (Date.now() - start < durationMs) {
    const roll = Math.random();
    try {
      if (roll < 0.5 && approvalIds.length) {
        const id = randomItem(approvalIds);
        const action = randomItem(allApprovalActions);
        await action(id);
      } else if (roll < 0.8 && parallelIds.length) {
        const id = randomItem(parallelIds);
        const action = randomItem(allParallelActions);
        await action(id);
      } else if (waitIds.length) {
        const id = randomItem(waitIds);
        const action = randomItem(allWaitActions);
        await action(id);
      }
    } catch (error) {
      // Ignore expected conflicts (terminal instance, etc.)
      if (![409, 404].includes(error.status)) {
        console.warn(`Action failed: ${error.message ?? error}`);
      }
    }
    actionsRun += 1;
    await sleep(actionIntervalMs);
  }

  console.log(`Actions completed: ${actionsRun}`);
  console.log("Polling for terminal or stable states...");

  const allIds = [
    ...approvalIds.map((id) => ({ id, workflow: "approval-workflow" })),
    ...parallelIds.map((id) => ({ id, workflow: "parallel-steps-workflow" })),
    ...waitIds.map((id) => ({ id, workflow: "wait-timeout-workflow" })),
  ];

  const remaining = new Set(allIds.map((entry) => `${entry.workflow}:${entry.id}`));
  const latest = new Map();
  const pollStart = Date.now();

  while (remaining.size && Date.now() - pollStart < pollTimeoutMs) {
    await Promise.all(
      allIds.map(async ({ id, workflow }) => {
        const key = `${workflow}:${id}`;
        if (!remaining.has(key)) {
          return;
        }
        try {
          const status = await getStatus(workflow, id);
          latest.set(key, status);
          if (["complete", "errored", "terminated"].includes(status.details.status)) {
            remaining.delete(key);
          }
        } catch (error) {
          if (![404].includes(error.status)) {
            console.warn(`Status check failed for ${key}: ${error.message ?? error}`);
          }
        }
      }),
    );
    if (remaining.size) {
      await sleep(pollIntervalMs);
    }
  }

  const findings = [];

  console.log("Validating invariants...");
  for (const { id, workflow } of allIds) {
    const key = `${workflow}:${id}`;
    const status = latest.get(key);
    if (!status) {
      continue;
    }

    if (workflow === "approval-workflow" && status.details.status === "complete") {
      const history = await getHistory(workflow, id);
      const eventTypes = new Set(history.events.map((event) => event.type));
      if (!eventTypes.has("approval") || !eventTypes.has("fulfillment")) {
        findings.push(`approval ${id} completed without both events`);
      }
    }

    if (workflow === "wait-timeout-workflow") {
      if (status.details.status === "complete") {
        const history = await getHistory(workflow, id);
        if (!history.events.some((event) => event.type === "edge")) {
          findings.push(`wait-timeout ${id} completed without edge event`);
        }
      }
      if (status.details.status === "errored") {
        const errorName = status.details.error?.name;
        if (errorName && errorName !== "WaitForEventTimeoutError") {
          findings.push(`wait-timeout ${id} errored with ${errorName}`);
        }
      }
    }

    if (workflow === "parallel-steps-workflow") {
      const history = await getHistory(workflow, id);
      const over = history.steps.filter(
        (step) => step.maxAttempts !== null && step.attempts > step.maxAttempts,
      );
      if (over.length) {
        findings.push(
          `parallel ${id} exceeded attempts on ${over.map((s) => s.stepKey).join(",")}`,
        );
      }
    }
  }

  if (findings.length) {
    console.error(`Scenario matrix detected ${findings.length} anomalies`);
    findings.slice(0, 10).forEach((finding) => console.error(`- ${finding}`));
    process.exit(1);
  }

  if (remaining.size) {
    console.warn(`Some instances still non-terminal: ${remaining.size}`);
  }

  console.log("Scenario matrix finished with no detected anomalies.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
