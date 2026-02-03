const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 30);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 30000);
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
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
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

async function getStatus(id) {
  const response = await request(`/approval-workflow/instances/${id}`);
  return response.details.status;
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `conc_${runId}_${i}`);

  console.log(`Creating ${ids.length} instances...`);
  const createResults = await Promise.allSettled(ids.map((id) => createInstance(id)));
  const createFailures = createResults.filter((r) => r.status === "rejected");
  if (createFailures.length) {
    console.error(`Create failures: ${createFailures.length}`);
    createFailures.slice(0, 5).forEach((r) => console.error(r.reason));
    process.exit(1);
  }

  console.log("Sending approval events concurrently...");
  const approvalResults = await Promise.allSettled(
    ids.map((id) => sendEvent(id, "approval", { approved: true, approver: "load" })),
  );
  const approvalFailures = approvalResults.filter((r) => r.status === "rejected");
  if (approvalFailures.length) {
    console.error(`Approval failures: ${approvalFailures.length}`);
    approvalFailures.slice(0, 5).forEach((r) => console.error(r.reason));
  }

  console.log("Sending fulfillment events concurrently...");
  const fulfillmentResults = await Promise.allSettled(
    ids.map((id) => sendEvent(id, "fulfillment", { confirmationId: `conf_${id}` })),
  );
  const fulfillmentFailures = fulfillmentResults.filter((r) => r.status === "rejected");
  if (fulfillmentFailures.length) {
    console.error(`Fulfillment failures: ${fulfillmentFailures.length}`);
    fulfillmentFailures.slice(0, 5).forEach((r) => console.error(r.reason));
  }

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

  if (remaining.size) {
    console.error(`Timed out waiting for ${remaining.size} instances`);
    remaining.forEach((id) => console.error(`- ${id}`));
    process.exit(1);
  }

  console.log("All instances completed or terminal.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
