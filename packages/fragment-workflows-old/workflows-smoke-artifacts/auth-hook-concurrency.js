const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 30);

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function createInstance(id) {
  return request(`/approval-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({
      id,
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "auth-test" },
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

function summarize(label, results) {
  const ok = results.filter((r) => r.ok);
  const unauthorized = results.filter((r) => r.status === 401);
  const failed = results.filter((r) => !r.ok && r.status !== 401);
  console.log(
    `${label}: ok=${ok.length} unauthorized=${unauthorized.length} otherErrors=${failed.length}`,
  );
  return {
    ok: ok.map((r) => r.id),
    unauthorized: unauthorized.map((r) => r.id),
    failed: failed.map((r) => ({ id: r.id, status: r.status, body: r.text })),
  };
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `auth_${runId}_${i}`);

  console.log(`Creating ${ids.length} instances...`);
  const createResults = await Promise.all(
    ids.map(async (id) => ({ id, ...(await createInstance(id)) })),
  );
  const createSummary = summarize("create", createResults);

  console.log("Issuing pause requests concurrently...");
  const pauseResults = await Promise.all(
    createSummary.ok.map(async (id) => ({ id, ...(await pauseInstance(id)) })),
  );
  const pauseSummary = summarize("pause", pauseResults);

  console.log("Issuing resume requests concurrently...");
  const resumeResults = await Promise.all(
    createSummary.ok.map(async (id) => ({ id, ...(await resumeInstance(id)) })),
  );
  const resumeSummary = summarize("resume", resumeResults);

  console.log("Sending approval events concurrently...");
  const approvalResults = await Promise.all(
    createSummary.ok.map(async (id) => ({
      id,
      ...(await sendEvent(id, "approval", { approved: true, approver: "auth-test" })),
    })),
  );
  const approvalSummary = summarize("approval", approvalResults);

  console.log("Sending fulfillment events concurrently...");
  const fulfillmentResults = await Promise.all(
    createSummary.ok.map(async (id) => ({
      id,
      ...(await sendEvent(id, "fulfillment", { confirmationId: `conf_${id}` })),
    })),
  );
  const fulfillmentSummary = summarize("fulfillment", fulfillmentResults);

  console.log(
    JSON.stringify(
      {
        runId,
        create: createSummary,
        pause: pauseSummary,
        resume: resumeSummary,
        approval: approvalSummary,
        fulfillment: fulfillmentSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
