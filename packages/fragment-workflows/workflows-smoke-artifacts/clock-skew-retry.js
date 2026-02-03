const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 6);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 500);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 45000);
const minRetryDelayMs = Number(process.env.MIN_RETRY_DELAY_MS ?? 200);
const maxRetryDelayMs = Number(process.env.MAX_RETRY_DELAY_MS ?? 5000);

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
  return request(`/demo-data-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

async function getStatus(id) {
  return request(`/demo-data-workflow/instances/${id}`);
}

async function getHistory(id) {
  return request(`/demo-data-workflow/instances/${id}/history?includeLogs=false&pageSize=50`);
}

async function waitForTerminal(id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus(id);
    if (["complete", "errored", "terminated"].includes(status.details.status)) {
      return status.details.status;
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

function analyzeFlakyStep(history) {
  const steps = (history.steps ?? []).filter((step) => step.stepKey === "flaky-step");
  if (!steps.length) {
    return { hasStep: false };
  }
  const sorted = steps.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const maxAttemptsObserved = Math.max(...sorted.map((step) => step.attempts));
  const maxAttemptsConfigured = Math.max(...sorted.map((step) => step.maxAttempts));
  const delays = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(sorted[i - 1].createdAt).getTime();
    const next = new Date(sorted[i].createdAt).getTime();
    delays.push(next - prev);
  }
  return { hasStep: true, sorted, maxAttemptsObserved, maxAttemptsConfigured, delays };
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `skew_retry_${runId}_${i}`);

  console.log(`Creating ${ids.length} demo-data instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  console.log("Waiting for instances to reach terminal state...");
  for (const id of ids) {
    const status = await waitForTerminal(id, pollTimeoutMs);
    if (!status) {
      throw new Error(`Instance ${id} did not reach terminal state in time.`);
    }
  }

  console.log("Validating retry attempts and delays...");
  const violations = [];
  for (const id of ids) {
    const history = await getHistory(id);
    const analysis = analyzeFlakyStep(history);
    if (!analysis.hasStep) {
      violations.push({ id, reason: "missing flaky-step history" });
      continue;
    }
    if (analysis.maxAttemptsObserved > analysis.maxAttemptsConfigured) {
      violations.push({
        id,
        reason: `attempts ${analysis.maxAttemptsObserved} > max ${analysis.maxAttemptsConfigured}`,
      });
    }
    const delayViolations = analysis.delays.filter(
      (delay) => delay < minRetryDelayMs || delay > maxRetryDelayMs,
    );
    if (delayViolations.length) {
      violations.push({
        id,
        reason: `retry delays out of bounds`,
        delays: delayViolations,
      });
    }
  }

  if (violations.length) {
    console.error(`Retry/backoff violations: ${violations.length}`);
    violations.slice(0, 5).forEach((entry) => {
      console.error(
        `- ${entry.id}: ${entry.reason}${entry.delays ? ` delays=${entry.delays.join(",")}` : ""}`,
      );
    });
    process.exit(1);
  }

  console.log("Clock skew retry checks finished with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
