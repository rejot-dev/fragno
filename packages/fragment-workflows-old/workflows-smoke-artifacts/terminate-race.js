const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 20);
const maxDelayMs = Number(process.env.MAX_DELAY_MS ?? 200);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 15000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 500);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}
if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
  throw new Error(`Invalid MAX_DELAY_MS: ${process.env.MAX_DELAY_MS}`);
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

async function terminateInstance(id) {
  return request(`/approval-workflow/instances/${id}/terminate`, { method: "POST" });
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `term_${runId}_${i}`);
  const terminateResults = new Map();

  console.log(`Creating ${ids.length} approval instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Sending approval events...");
  const approvalResults = await Promise.allSettled(
    ids.map((id) => sendEvent(id, "approval", { approved: true, approver: "race" })),
  );
  const approvalFailures = approvalResults.filter((r) => r.status === "rejected");
  if (approvalFailures.length) {
    console.error(`Approval failures: ${approvalFailures.length}`);
    approvalFailures.slice(0, 5).forEach((r) => console.error(r.reason));
  }

  console.log("Issuing terminate calls with randomized delays...");
  const terminateCalls = ids.map(async (id) => {
    const delay = Math.floor(Math.random() * maxDelayMs);
    await sleep(delay);
    try {
      await terminateInstance(id);
      terminateResults.set(id, { ok: true, delay });
    } catch (error) {
      terminateResults.set(id, { ok: false, delay, error });
    }
  });

  await Promise.all(terminateCalls);

  const failedTerminates = Array.from(terminateResults.entries()).filter(
    ([, result]) => !result.ok,
  );
  if (failedTerminates.length) {
    console.warn(`Terminate failures: ${failedTerminates.length}`);
    failedTerminates.slice(0, 5).forEach(([id, result]) => {
      console.warn(`- ${id}: ${result.error?.message ?? result.error}`);
    });
  }

  console.log("Polling for terminal statuses...");
  const remaining = new Set(ids);
  const start = Date.now();
  const latest = new Map();

  while (remaining.size && Date.now() - start < pollTimeoutMs) {
    await Promise.all(
      Array.from(remaining).map(async (id) => {
        try {
          const status = await getStatus(id);
          latest.set(id, status);
          if (["terminated", "complete", "errored"].includes(status.details.status)) {
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

  const nonTerminated = [];
  for (const [id, result] of terminateResults.entries()) {
    if (!result.ok) {
      continue;
    }
    const status = latest.get(id);
    if (!status) {
      continue;
    }
    if (status.details.status !== "terminated") {
      nonTerminated.push({ id, status: status.details.status, meta: status.meta });
    }
  }

  if (nonTerminated.length) {
    console.error(`Non-terminated instances after successful terminate: ${nonTerminated.length}`);
    nonTerminated.slice(0, 5).forEach((entry) => {
      console.error(`- ${entry.id}: ${entry.status}`);
    });
    process.exit(1);
  }

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances to reach terminal state.`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("Terminate race finished with no mismatches.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
