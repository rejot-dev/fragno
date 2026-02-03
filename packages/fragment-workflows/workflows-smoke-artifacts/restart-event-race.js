const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 20);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 8000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 400);

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
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "race" },
    }),
  });
}

async function restartInstance(id) {
  return request(`/approval-workflow/instances/${id}/restart`, { method: "POST" });
}

async function sendApproval(id) {
  return request(`/approval-workflow/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "approval", payload: { approved: true, approver: "race" } }),
  });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `re_${runId}_${i}`);

  console.log(`Creating ${ids.length} approval instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  console.log("Racing approval vs restart...");
  const raceResults = await Promise.all(
    ids.map(async (id) => {
      const [approval, restart] = await Promise.allSettled([sendApproval(id), restartInstance(id)]);
      return { id, approval, restart };
    }),
  );

  const failedRestarts = raceResults.filter((r) => r.restart.status === "rejected");
  if (failedRestarts.length) {
    console.warn(`Restart failures: ${failedRestarts.length}`);
    failedRestarts.slice(0, 5).forEach((r) => {
      console.warn(`- ${r.id}: ${r.restart.reason?.message ?? r.restart.reason}`);
    });
  }

  console.log("Polling for runNumber=1 to appear...");
  const remaining = new Set(ids);
  const latest = new Map();
  const start = Date.now();
  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        try {
          const status = await getStatus(id);
          latest.set(id, status);
          if (status.meta?.runNumber >= 1) {
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
  for (const { id } of raceResults) {
    const status = latest.get(id);
    if (!status) {
      continue;
    }
    if (status.meta?.runNumber >= 1) {
      const state = status.details?.status;
      const currentStep = status.meta?.currentStep;
      if (
        state === "waiting" &&
        currentStep?.waitEventType &&
        currentStep.waitEventType !== "approval"
      ) {
        suspicious.push({ id, reason: `waiting-for-${currentStep.waitEventType}` });
      }
      if (state === "complete" || state === "errored" || state === "terminated") {
        suspicious.push({ id, reason: `terminal=${state}` });
      }
    }
  }

  if (suspicious.length) {
    console.error(`Approval event leaked into restarted runs for ${suspicious.length} instances`);
    suspicious.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.reason}`);
    });
    process.exit(1);
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances to restart.`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Restart/approval race finished with no leaks detected.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
