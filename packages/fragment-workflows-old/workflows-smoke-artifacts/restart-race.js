const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 10);
const restartDelayMs = Number(process.env.RESTART_DELAY_MS ?? 100);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 8000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 400);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}
if (!Number.isFinite(restartDelayMs) || restartDelayMs < 0) {
  throw new Error(`Invalid RESTART_DELAY_MS: ${process.env.RESTART_DELAY_MS}`);
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
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function createInstance(id) {
  return request(`/approval-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({
      id,
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "load" },
    }),
  });
}

async function sendEvent(id, type, payload) {
  return request(`/approval-workflow/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function restartInstance(id) {
  return request(`/approval-workflow/instances/${id}/restart`, { method: "POST" });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `rst_${runId}_${i}`);

  console.log(`Creating ${ids.length} approval instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Sending approval events for run 0...");
  const approvalResults = await Promise.allSettled(
    ids.map((id) => sendEvent(id, "approval", { approved: true, approver: "race" })),
  );
  const approvalFailures = approvalResults.filter((r) => r.status === "rejected");
  if (approvalFailures.length) {
    console.error(`Approval failures: ${approvalFailures.length}`);
    approvalFailures.slice(0, 5).forEach((r) => console.error(r.reason));
  }

  await sleep(restartDelayMs);

  console.log("Issuing restart calls...");
  const restartResults = await Promise.allSettled(ids.map((id) => restartInstance(id)));
  const restartFailures = restartResults.filter((r) => r.status === "rejected");
  if (restartFailures.length) {
    console.error(`Restart failures: ${restartFailures.length}`);
    restartFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Polling for restarted instances to remain waiting for approval...");
  const remaining = new Set(ids);
  const start = Date.now();
  const latest = new Map();

  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        try {
          const status = await getStatus(id);
          latest.set(id, status);
          if (status.meta?.runNumber >= 1 && status.details.status === "waiting") {
            remaining.delete(id);
          }
        } catch (error) {
          console.error(`Status check failed for ${id}:`, error.message ?? error);
        }
      }),
    );
    if (remaining.size) {
      await sleep(pollIntervalMs);
    }
  }

  const suspicious = [];
  for (const id of ids) {
    const status = latest.get(id);
    if (!status) {
      continue;
    }
    const runNumber = status.meta?.runNumber;
    const currentStep = status.meta?.currentStep;
    if (runNumber < 1) {
      suspicious.push({ id, reason: `runNumber=${runNumber}` });
      continue;
    }
    const state = status.details.status;
    if (state === "complete" || state === "errored" || state === "terminated") {
      suspicious.push({ id, reason: `terminal=${state}` });
      continue;
    }
    if (
      state === "waiting" &&
      currentStep?.waitEventType &&
      currentStep.waitEventType !== "approval"
    ) {
      suspicious.push({ id, reason: `waiting-for-${currentStep.waitEventType}` });
    }
  }

  if (suspicious.length) {
    console.error(`Unexpected restart behavior for ${suspicious.length} instances`);
    suspicious.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.reason}`);
    });
    process.exit(1);
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances to reach waiting state.`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Restart race finished with no mismatches.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
