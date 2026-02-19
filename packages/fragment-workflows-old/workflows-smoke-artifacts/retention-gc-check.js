const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const workflowName = process.env.WORKFLOW_NAME ?? "demo-data-workflow";
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 20000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);

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
  return request(`/${workflowName}/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

async function getStatus(id) {
  return request(`/${workflowName}/instances/${id}`);
}

async function waitForTerminal(id) {
  const start = Date.now();
  while (Date.now() - start < pollTimeoutMs) {
    const status = await getStatus(id);
    if (["complete", "errored", "terminated"].includes(status?.details?.status)) {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${id} to reach terminal state`);
}

async function main() {
  const runId = Date.now().toString(36);
  const id = `retention_${runId}`;
  console.log(`Creating ${workflowName} instance ${id}...`);
  await createInstance(id);
  const status = await waitForTerminal(id);
  console.log(`Terminal status for ${id}: ${status.details.status}`);
  console.log(`InstanceId: ${id}`);
  console.log(`CompletedAt: ${status.details.completedAt ?? "(none)"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
