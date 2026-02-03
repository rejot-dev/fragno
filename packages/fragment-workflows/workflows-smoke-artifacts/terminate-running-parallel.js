const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 10);
const terminateDelayMs = Number(process.env.TERMINATE_DELAY_MS ?? 200);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 15000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 500);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}
if (!Number.isFinite(terminateDelayMs) || terminateDelayMs < 0) {
  throw new Error(`Invalid TERMINATE_DELAY_MS: ${process.env.TERMINATE_DELAY_MS}`);
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
  return request(`/parallel-steps-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

async function terminateInstance(id) {
  return request(`/parallel-steps-workflow/instances/${id}/terminate`, { method: "POST" });
}

async function getStatus(id) {
  return request(`/parallel-steps-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `tp_${runId}_${i}`);
  const terminateResults = new Map();

  console.log(`Creating ${ids.length} parallel instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  await sleep(terminateDelayMs);

  console.log("Terminating instances...");
  await Promise.all(
    ids.map(async (id) => {
      try {
        await terminateInstance(id);
        terminateResults.set(id, { ok: true });
      } catch (error) {
        terminateResults.set(id, { ok: false, error });
      }
    }),
  );

  console.log("Polling for terminal statuses...");
  const remaining = new Set(ids);
  const latest = new Map();
  const start = Date.now();
  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        const status = await getStatus(id);
        latest.set(id, status);
        if (["terminated", "complete", "errored"].includes(status.details.status)) {
          remaining.delete(id);
        }
      }),
    );
    if (remaining.size) {
      await sleep(pollIntervalMs);
    }
  }

  const mismatches = [];
  for (const [id, result] of terminateResults.entries()) {
    if (!result.ok) {
      continue;
    }
    const status = latest.get(id);
    if (!status) {
      continue;
    }
    if (status.details.status !== "terminated") {
      mismatches.push({ id, status: status.details.status });
    }
  }

  if (mismatches.length) {
    console.error(
      `Terminate overwritten by workflow completion for ${mismatches.length} instances`,
    );
    mismatches.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.status}`);
    });
    process.exit(1);
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances to reach terminal state.`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Terminate-running test finished with no overwrites detected.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
