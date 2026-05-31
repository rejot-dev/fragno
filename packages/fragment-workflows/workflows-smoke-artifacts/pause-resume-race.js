const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 20);
const maxDelayMs = Number(process.env.MAX_DELAY_MS ?? 150);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 10000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 400);
const settleMs = Number(process.env.SETTLE_MS ?? 1500);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}
if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
  throw new Error(`Invalid MAX_DELAY_MS: ${process.env.MAX_DELAY_MS}`);
}
if (!Number.isFinite(settleMs) || settleMs < 0) {
  throw new Error(`Invalid SETTLE_MS: ${process.env.SETTLE_MS}`);
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
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "race" },
    }),
  });
}

async function pauseInstance(id) {
  return request(`/approval-workflow/instances/${id}/pause`, { method: "POST" });
}

async function resumeInstance(id) {
  return request(`/approval-workflow/instances/${id}/resume`, { method: "POST" });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `pr_${runId}_${i}`);

  console.log(`Creating ${ids.length} approval instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Issuing pause/resume calls with randomized delays...");
  const toggles = ids.map(async (id) => {
    const pauseDelay = Math.floor(Math.random() * maxDelayMs);
    const resumeDelay = Math.floor(Math.random() * maxDelayMs);
    await Promise.all([
      (async () => {
        await sleep(pauseDelay);
        try {
          await pauseInstance(id);
        } catch (error) {
          // pause can fail if instance already terminal; log and keep going
          console.warn(`pause failed for ${id}: ${error.message ?? error}`);
        }
      })(),
      (async () => {
        await sleep(resumeDelay);
        try {
          await resumeInstance(id);
        } catch (error) {
          console.warn(`resume failed for ${id}: ${error.message ?? error}`);
        }
      })(),
    ]);
  });

  await Promise.all(toggles);

  console.log("Polling and resuming until paused states settle...");
  const start = Date.now();
  const latest = new Map();
  let stableSince = null;

  while (Date.now() - start < pollTimeoutMs) {
    const paused = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const status = await getStatus(id);
          latest.set(id, status);
          if (status.details.status === "paused") {
            paused.push(id);
          }
        } catch (error) {
          console.error(`Status check failed for ${id}:`, error.message ?? error);
          stableSince = null;
        }
      }),
    );

    if (paused.length) {
      stableSince = null;
      await Promise.all(
        paused.map(async (id) => {
          try {
            await resumeInstance(id);
          } catch (error) {
            console.warn(`settle resume failed for ${id}: ${error.message ?? error}`);
          }
        }),
      );
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= settleMs) {
        break;
      }
    }

    await sleep(pollIntervalMs);
  }

  const stuck = ids.filter((id) => latest.get(id)?.details?.status === "paused");
  if (stuck.length || stableSince === null || Date.now() - stableSince < settleMs) {
    console.error(`Instances did not settle outside paused state: ${stuck.length || ids.length}`);
    (stuck.length ? stuck : ids).slice(0, 10).forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Pause/resume race finished with no stuck instances.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
