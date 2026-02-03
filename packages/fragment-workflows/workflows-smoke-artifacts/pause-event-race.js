const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 10);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 15000);
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
  const ids = Array.from({ length: count }, (_, i) => `pe_${runId}_${i}`);

  console.log(`Creating ${ids.length} approval instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Pausing instances...");
  await Promise.all(ids.map((id) => pauseInstance(id)));

  console.log("Sending approval events while paused...");
  await Promise.all(
    ids.map((id) => sendEvent(id, "approval", { approved: true, approver: "race" })),
  );

  await sleep(1500);

  const progressed = [];
  for (const id of ids) {
    const status = await getStatus(id);
    if (status.details.status !== "paused" && status.details.status !== "waitingForPause") {
      progressed.push({ id, status: status.details.status, currentStep: status.meta?.currentStep });
    }
  }

  if (progressed.length) {
    console.error(`Instances progressed while paused: ${progressed.length}`);
    progressed.slice(0, 5).forEach((entry) => {
      console.error(
        `- ${entry.id}: ${entry.status} (${entry.currentStep?.waitEventType ?? "step"})`,
      );
    });
    process.exit(1);
  }

  console.log("Resuming instances...");
  await Promise.all(ids.map((id) => resumeInstance(id)));

  console.log("Sending fulfillment events...");
  await Promise.all(
    ids.map((id) => sendEvent(id, "fulfillment", { confirmationId: `conf_${id}` })),
  );

  console.log("Polling for completion...");
  const remaining = new Set(ids);
  const start = Date.now();
  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        const status = await getStatus(id);
        if (["complete", "errored", "terminated"].includes(status.details.status)) {
          remaining.delete(id);
        }
      }),
    );
    if (remaining.size) {
      await sleep(pollIntervalMs);
    }
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Pause/event race finished with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
