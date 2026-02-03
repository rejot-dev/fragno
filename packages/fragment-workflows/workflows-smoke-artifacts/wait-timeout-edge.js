const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const countBefore = Number(process.env.COUNT_BEFORE ?? 10);
const countAfter = Number(process.env.COUNT_AFTER ?? 10);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 2000);
const earlyOffsetMs = Number(process.env.EARLY_OFFSET_MS ?? 150);
const lateOffsetMs = Number(process.env.LATE_OFFSET_MS ?? 150);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 8000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);

if (!Number.isFinite(countBefore) || countBefore < 0) {
  throw new Error(`Invalid COUNT_BEFORE: ${process.env.COUNT_BEFORE}`);
}
if (!Number.isFinite(countAfter) || countAfter < 0) {
  throw new Error(`Invalid COUNT_AFTER: ${process.env.COUNT_AFTER}`);
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

async function sendEdgeEvent(id, payload) {
  return request(`/wait-timeout-workflow/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "edge", payload }),
  });
}

async function getStatus(id) {
  return request(`/wait-timeout-workflow/instances/${id}`);
}

async function waitForWaiting(id, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await getStatus(id);
    if (status.details.status === "waiting") {
      return { status: "waiting", snapshot: status };
    }
    if (["complete", "errored", "terminated"].includes(status.details.status)) {
      return { status: "terminal", snapshot: status };
    }
    await sleep(200);
  }
  return { status: "timeout" };
}

async function main() {
  const runId = Date.now().toString(36);
  const beforeIds = Array.from({ length: countBefore }, (_, i) => `edge_before_${runId}_${i}`);
  const afterIds = Array.from({ length: countAfter }, (_, i) => `edge_after_${runId}_${i}`);
  const allIds = [...beforeIds, ...afterIds];

  console.log(`Creating ${allIds.length} wait-timeout instances...`);
  await Promise.all(allIds.map((id) => createInstance(id)));

  console.log("Waiting for instances to reach waiting state...");
  const waitingResults = await Promise.all(
    allIds.map(async (id) => ({ id, result: await waitForWaiting(id) })),
  );

  const waitFailures = waitingResults.filter((entry) => entry.result.status !== "waiting");
  if (waitFailures.length) {
    console.error(`Some instances did not reach waiting state: ${waitFailures.length}`);
    waitFailures.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.result.status}`);
    });
  }

  console.log("Scheduling edge events relative to waiting state...");
  const sendPromises = [];
  for (const id of beforeIds) {
    sendPromises.push(
      new Promise((resolve) => {
        const delay = Math.max(0, timeoutMs - earlyOffsetMs);
        setTimeout(() => {
          sendEdgeEvent(id, { expected: "before", sentAt: Date.now() })
            .catch((error) => {
              console.error(`sendEdgeEvent before failed for ${id}:`, error.message ?? error);
            })
            .finally(resolve);
        }, delay);
      }),
    );
  }

  for (const id of afterIds) {
    sendPromises.push(
      new Promise((resolve) => {
        const delay = timeoutMs + lateOffsetMs;
        setTimeout(() => {
          sendEdgeEvent(id, { expected: "after", sentAt: Date.now() })
            .catch((error) => {
              console.error(`sendEdgeEvent after failed for ${id}:`, error.message ?? error);
            })
            .finally(resolve);
        }, delay);
      }),
    );
  }

  await Promise.all(sendPromises);

  console.log("Polling for completion/timeout...");
  const pollStart = Date.now();
  const remaining = new Set(allIds);
  const latest = new Map();
  while (remaining.size && Date.now() - pollStart < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        try {
          const status = await getStatus(id);
          latest.set(id, status);
          if (["complete", "errored", "terminated"].includes(status.details.status)) {
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

  const beforeFailures = [];
  for (const id of beforeIds) {
    const status = latest.get(id);
    if (!status || status.details.status !== "complete") {
      beforeFailures.push({ id, status: status?.details?.status });
    }
  }

  const afterLeaks = [];
  const afterTimeoutFailures = [];
  for (const id of afterIds) {
    const status = latest.get(id);
    if (!status) {
      continue;
    }
    if (status.details.status === "complete") {
      afterLeaks.push(id);
    } else if (status.details.status !== "errored") {
      afterTimeoutFailures.push({ id, status: status.details.status });
    }
  }

  if (beforeFailures.length) {
    console.error(`Events sent before timeout did not complete: ${beforeFailures.length}`);
    beforeFailures.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.status ?? "unknown"}`);
    });
    process.exit(1);
  }

  if (afterLeaks.length) {
    console.error(`Events sent after timeout completed unexpectedly: ${afterLeaks.length}`);
    afterLeaks.slice(0, 5).forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  if (afterTimeoutFailures.length) {
    console.error(`After-timeout instances not in errored state: ${afterTimeoutFailures.length}`);
    afterTimeoutFailures.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.status}`);
    });
    process.exit(1);
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Wait-timeout edge test finished with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
