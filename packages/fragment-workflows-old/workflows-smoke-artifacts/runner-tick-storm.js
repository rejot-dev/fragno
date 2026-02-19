const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 10);
const tickBurst = Number(process.env.TICK_BURST ?? 20);
const tickRounds = Number(process.env.TICK_ROUNDS ?? 5);
const tickDelayMs = Number(process.env.TICK_DELAY_MS ?? 200);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 90000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 1000);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}

if (!Number.isFinite(tickBurst) || tickBurst <= 0) {
  throw new Error(`Invalid TICK_BURST: ${process.env.TICK_BURST}`);
}

if (!Number.isFinite(tickRounds) || tickRounds <= 0) {
  throw new Error(`Invalid TICK_ROUNDS: ${process.env.TICK_ROUNDS}`);
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
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return response.status === 204 ? null : response.json();
}

async function createInstance(id) {
  return request(`/parallel-steps-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

async function getStatus(id) {
  const response = await request(`/parallel-steps-workflow/instances/${id}`);
  return response.details.status;
}

async function tickOnce() {
  return request(`/_runner/tick`, { method: "POST" });
}

function collectAttemptViolations(value, results = []) {
  if (!value || typeof value !== "object") {
    return results;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "attempts") &&
    Object.prototype.hasOwnProperty.call(value, "maxAttempts")
  ) {
    const attempts = Number(value.attempts);
    const maxAttempts = Number(value.maxAttempts);
    if (Number.isFinite(attempts) && Number.isFinite(maxAttempts) && attempts > maxAttempts) {
      results.push({ attempts, maxAttempts, entry: value });
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectAttemptViolations(item, results));
  } else {
    Object.values(value).forEach((item) => collectAttemptViolations(item, results));
  }
  return results;
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `tick_${runId}_${i}`);

  console.log(`Creating ${ids.length} parallel instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log(`Running tick storm: ${tickRounds} rounds x ${tickBurst} concurrent ticks...`);
  const tickStorm = (async () => {
    for (let round = 0; round < tickRounds; round += 1) {
      const results = await Promise.allSettled(Array.from({ length: tickBurst }, () => tickOnce()));
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length) {
        console.error(`Tick failures in round ${round + 1}: ${failures.length}`);
        failures.slice(0, 3).forEach((r) => console.error(r.reason));
      } else {
        const processedTotal = results
          .filter((r) => r.status === "fulfilled")
          .map((r) => r.value?.processed ?? 0)
          .reduce((sum, value) => sum + value, 0);
        console.log(`Round ${round + 1}: processed ${processedTotal}`);
      }
      if (round < tickRounds - 1) {
        await sleep(tickDelayMs);
      }
    }
  })();

  console.log("Polling for completion...");
  const remaining = new Set(ids);
  const start = Date.now();
  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        try {
          const status = await getStatus(id);
          if (status === "complete" || status === "errored" || status === "terminated") {
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

  await tickStorm;

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Checking histories for attempt violations...");
  const violations = [];
  for (const id of ids) {
    const history = await request(`/parallel-steps-workflow/instances/${id}/history`);
    const instanceViolations = collectAttemptViolations(history).map((item) => ({
      id,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
    }));
    violations.push(...instanceViolations);
  }

  if (violations.length) {
    console.error(`Found ${violations.length} attempt violations.`);
    violations.slice(0, 5).forEach((violation) => console.error(violation));
    process.exit(1);
  }

  console.log("No attempt violations detected.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
