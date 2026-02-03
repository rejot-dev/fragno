const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 10);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 12000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 500);

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

async function sendEvent(id, type, payload) {
  return request(`/approval-workflow/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `rf_${runId}_${i}`);

  console.log(`Creating ${ids.length} approval instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  console.log("Sending fulfillment events before approval...");
  await Promise.all(
    ids.map((id) => sendEvent(id, "fulfillment", { confirmationId: `conf_${id}` })),
  );

  console.log("Restarting instances...");
  await Promise.all(ids.map((id) => restartInstance(id)));

  console.log("Sending approval events for restarted runs...");
  await Promise.all(
    ids.map((id) => sendEvent(id, "approval", { approved: true, approver: "race" })),
  );

  console.log("Polling to see if any instances complete without new fulfillment...");
  const remaining = new Set(ids);
  const latest = new Map();
  const start = Date.now();
  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        const status = await getStatus(id);
        latest.set(id, status);
        if (["complete", "errored", "terminated"].includes(status.details.status)) {
          remaining.delete(id);
        }
      }),
    );
    if (remaining.size) {
      await sleep(pollIntervalMs);
    }
  }

  const leaked = [];
  for (const [id, status] of latest.entries()) {
    if (status.meta?.runNumber >= 1 && status.details.status === "complete") {
      leaked.push(id);
    }
  }

  if (leaked.length) {
    console.error(`Fulfillment events leaked into restarted runs for ${leaked.length} instances`);
    leaked.slice(0, 5).forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  if (remaining.size) {
    console.warn(`Instances still waiting (expected, missing fulfillment): ${remaining.size}`);
  }

  console.log("Restart/fulfillment leak test finished with no leaks detected.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
