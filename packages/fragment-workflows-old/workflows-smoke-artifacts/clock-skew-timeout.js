const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 6);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 250);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 20000);
const maxSkewMs = Number(process.env.MAX_ALLOWED_SKEW_MS ?? 10000);
const earlyToleranceMs = Number(process.env.EARLY_TOLERANCE_MS ?? 500);

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
  return request(`/wait-timeout-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

async function getStatus(id) {
  return request(`/wait-timeout-workflow/instances/${id}`);
}

async function getHistory(id) {
  return request(`/wait-timeout-workflow/instances/${id}/history?includeLogs=false&pageSize=25`);
}

async function waitForStatus(id, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus(id);
    if (predicate(status)) {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

function getEdgeWaitStep(history) {
  const steps = history.steps ?? [];
  return steps.find((step) => step.stepKey === "edge-wait") ?? null;
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `skew_timeout_${runId}_${i}`);

  console.log(`Creating ${ids.length} wait-timeout instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  console.log("Waiting for instances to reach waiting state...");
  for (const id of ids) {
    const waiting = await waitForStatus(
      id,
      (status) => status.details.status === "waiting",
      pollTimeoutMs,
    );
    if (!waiting) {
      throw new Error(`Instance ${id} did not reach waiting state in time.`);
    }
  }

  console.log("Collecting wakeAt timestamps...");
  const wakeAtById = new Map();
  for (const id of ids) {
    const history = await getHistory(id);
    const step = getEdgeWaitStep(history);
    if (!step?.wakeAt) {
      throw new Error(`Missing wakeAt for ${id}.`);
    }
    wakeAtById.set(id, step.wakeAt);
  }

  console.log("Waiting for timeouts...");
  for (const id of ids) {
    const errored = await waitForStatus(
      id,
      (status) => status.details.status === "errored",
      pollTimeoutMs,
    );
    if (!errored) {
      throw new Error(`Instance ${id} did not timeout in time.`);
    }
  }

  console.log("Validating timeout timing...");
  const violations = [];
  for (const id of ids) {
    const history = await getHistory(id);
    const step = getEdgeWaitStep(history);
    if (!step?.updatedAt) {
      violations.push({ id, reason: "missing updatedAt" });
      continue;
    }
    const wakeAt = new Date(wakeAtById.get(id)).getTime();
    const updatedAt = new Date(step.updatedAt).getTime();
    const deltaMs = updatedAt - wakeAt;
    if (deltaMs < -earlyToleranceMs || deltaMs > maxSkewMs) {
      violations.push({ id, deltaMs, wakeAt: step.wakeAt, updatedAt: step.updatedAt });
    }
  }

  if (violations.length) {
    console.error(`Timeout skew violations: ${violations.length}`);
    violations.slice(0, 5).forEach((entry) => {
      console.error(
        `- ${entry.id}: deltaMs=${entry.deltaMs ?? "n/a"} wakeAt=${entry.wakeAt ?? "n/a"} updatedAt=${entry.updatedAt ?? "n/a"}`,
      );
    });
    process.exit(1);
  }

  console.log("Clock skew timeout checks finished with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
