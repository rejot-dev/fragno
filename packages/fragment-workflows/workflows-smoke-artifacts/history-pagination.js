import { execFileSync } from "node:child_process";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const pageSize = Number(process.env.PAGE_SIZE ?? 2);
const eventCount = Number(process.env.EVENT_COUNT ?? 20);
const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? 20000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 300);
const pgUrl =
  process.env.PG_URL ??
  process.env.WF_EXAMPLE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5436/wilco";

if (!Number.isFinite(pageSize) || pageSize <= 0) {
  throw new Error(`Invalid PAGE_SIZE: ${process.env.PAGE_SIZE}`);
}
if (!Number.isFinite(eventCount) || eventCount <= 0) {
  throw new Error(`Invalid EVENT_COUNT: ${process.env.EVENT_COUNT}`);
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
      params: { requestId: `req_${id}`, amount: 100, requestedBy: "pager" },
    }),
  });
}

async function pauseInstance(id) {
  return request(`/approval-workflow/instances/${id}/pause`, { method: "POST" });
}

async function resumeInstance(id) {
  return request(`/approval-workflow/instances/${id}/resume`, { method: "POST" });
}

async function sendEventAllowTerminal(id, type, payload) {
  const response = await fetch(`${baseUrl}/approval-workflow/instances/${id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  if (response.ok) {
    return response.json();
  }
  if (response.status === 409) {
    const text = await response.text();
    if (text.includes("INSTANCE_TERMINAL")) {
      return null;
    }
  }
  const text = await response.text();
  throw new Error(`POST /approval-workflow/instances/${id}/events -> ${response.status}: ${text}`);
}

async function getStatus(id) {
  return request(`/approval-workflow/instances/${id}`);
}

async function waitForStatus(id, predicate, label) {
  const start = Date.now();
  while (Date.now() - start < pollTimeoutMs) {
    const status = await getStatus(id);
    if (predicate(status)) {
      return status;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${id} to reach ${label}`);
}

async function createEvents(id, type, count, suffix) {
  const payloads = Array.from({ length: count }, (_, i) => ({
    marker: `${suffix}_${i}`,
  }));
  const sends = payloads.map((payload) => sendEventAllowTerminal(id, type, payload));
  const results = await Promise.allSettled(sends);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) {
    const reason = failures[0].reason?.message ?? failures[0].reason;
    throw new Error(`Failed sending ${type} events: ${reason}`);
  }
}

function buildQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    query.set(key, String(value));
  });
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

async function paginateHistoryCategory({ id, category, order, includeLogs }) {
  let cursor = undefined;
  let hasNext = true;
  const items = [];
  const seen = new Set();
  const duplicates = [];
  const badCursor = [];

  while (hasNext) {
    const query = buildQuery({
      pageSize,
      order,
      includeLogs: includeLogs ? "true" : "false",
      [`${category}Cursor`]: cursor,
    });
    const history = await request(`/approval-workflow/instances/${id}/history${query}`);
    let pageItems = [];
    if (category === "steps") {
      pageItems = history.steps ?? [];
      hasNext = history.stepsHasNextPage;
      cursor = history.stepsCursor;
    } else if (category === "events") {
      pageItems = history.events ?? [];
      hasNext = history.eventsHasNextPage;
      cursor = history.eventsCursor;
    } else {
      pageItems = history.logs ?? [];
      hasNext = history.logsHasNextPage ?? false;
      cursor = history.logsCursor;
    }

    for (const item of pageItems) {
      if (seen.has(item.id)) {
        duplicates.push(item.id);
      } else {
        seen.add(item.id);
        items.push(item);
      }
    }

    if (hasNext && !cursor) {
      badCursor.push({
        reason: "hasNextPage true but cursor missing",
      });
      break;
    }

    if (!hasNext) {
      break;
    }
  }

  return { items, duplicates, badCursor };
}

function isSortedByCreatedAt(items, order) {
  for (let i = 1; i < items.length; i += 1) {
    const prev = new Date(items[i - 1].createdAt).getTime();
    const curr = new Date(items[i].createdAt).getTime();
    if (order === "asc" && curr < prev) {
      return false;
    }
    if (order === "desc" && curr > prev) {
      return false;
    }
  }
  return true;
}

function psqlQuery(query) {
  const output = execFileSync("psql", [pgUrl, "-At", "-F", ",", "-c", query], {
    encoding: "utf8",
  }).trim();
  if (!output) {
    return [];
  }
  return output.split("\n").map((line) => {
    const [id, createdAt] = line.split(",");
    return { id, createdAt };
  });
}

function loadDbHistory({ table, workflowName, instanceId, runNumber, order }) {
  const direction = order === "desc" ? "desc" : "asc";
  const query = `select id, "createdAt" from "${table}" where "workflowName" = '${workflowName}' and "instanceId" = '${instanceId}' and "runNumber" = ${runNumber} order by "createdAt" ${direction}, id ${direction};`;
  return psqlQuery(query);
}

function compareWithDb({ category, order, apiItems, dbItems }) {
  const issues = [];
  const apiIds = new Set(apiItems.map((item) => item.id));
  const dbIds = new Set(dbItems.map((item) => item.id));

  if (apiItems.length !== dbItems.length) {
    issues.push({
      type: "count-mismatch",
      message: `${category} ${order} count mismatch: api=${apiItems.length} db=${dbItems.length}`,
    });
  }

  const missing = dbItems.filter((item) => !apiIds.has(item.id));
  if (missing.length) {
    issues.push({
      type: "missing",
      message: `${category} ${order} missing ${missing.length} items`,
      sample: missing.slice(0, 5),
    });
  }

  const extra = apiItems.filter((item) => !dbIds.has(item.id));
  if (extra.length) {
    issues.push({
      type: "extra",
      message: `${category} ${order} has ${extra.length} extra items`,
      sample: extra.slice(0, 5).map((item) => ({ id: item.id })),
    });
  }

  if (!isSortedByCreatedAt(apiItems, order)) {
    issues.push({
      type: "order",
      message: `${category} ${order} not sorted by createdAt`,
    });
  }

  if (apiItems.length && dbItems.length) {
    const apiFirst = apiItems[0]?.createdAt;
    const apiLast = apiItems[apiItems.length - 1]?.createdAt;
    const dbFirst = dbItems[0]?.createdAt;
    const dbLast = dbItems[dbItems.length - 1]?.createdAt;
    if (apiFirst !== dbFirst || apiLast !== dbLast) {
      issues.push({
        type: "boundary",
        message: `${category} ${order} boundary mismatch: api(${apiFirst}..${apiLast}) db(${dbFirst}..${dbLast})`,
      });
    }
  }

  return issues;
}

async function main() {
  const runId = Date.now().toString(36);
  const instanceId = `hist_${runId}`;

  console.log(`Creating instance ${instanceId}...`);
  await createInstance(instanceId);

  await pauseInstance(instanceId);
  await waitForStatus(instanceId, (status) => status.details.status === "paused", "paused");

  console.log(`Sending ${eventCount} approval events while paused...`);
  await createEvents(instanceId, "approval", eventCount, `approval_${runId}`);

  await resumeInstance(instanceId);
  await waitForStatus(
    instanceId,
    (status) =>
      status.details.status === "waiting" &&
      status.meta?.currentStep?.waitEventType === "fulfillment",
    "waiting for fulfillment",
  );

  console.log(`Sending ${eventCount} fulfillment events while waiting...`);
  await createEvents(instanceId, "fulfillment", eventCount, `fulfillment_${runId}`);

  const finalStatus = await waitForStatus(
    instanceId,
    (status) => ["complete", "errored", "terminated"].includes(status.details.status),
    "terminal",
  );

  const runNumber = finalStatus.meta?.runNumber ?? 0;

  const results = [];
  for (const order of ["asc", "desc"]) {
    for (const category of ["steps", "events", "logs"]) {
      const includeLogs = category === "logs";
      console.log(`Paging ${category} (${order})...`);
      const pagination = await paginateHistoryCategory({
        id: instanceId,
        category,
        order,
        includeLogs,
      });

      if (pagination.duplicates.length) {
        results.push({
          order,
          category,
          issue: `duplicate ids across pages: ${pagination.duplicates.slice(0, 5).join(", ")}`,
        });
      }
      if (pagination.badCursor.length) {
        results.push({
          order,
          category,
          issue: `missing cursor while hasNextPage`,
        });
      }

      const table =
        category === "steps"
          ? "workflow_step_workflows"
          : category === "events"
            ? "workflow_event_workflows"
            : "workflow_log_workflows";

      const dbItems = loadDbHistory({
        table,
        workflowName: "approval-workflow",
        instanceId,
        runNumber,
        order,
      });

      const issues = compareWithDb({
        category,
        order,
        apiItems: pagination.items,
        dbItems,
      });
      for (const issue of issues) {
        results.push({ order, category, issue: issue.message, detail: issue.sample });
      }

      console.log(
        `${category} ${order}: api=${pagination.items.length} db=${dbItems.length} duplicates=${pagination.duplicates.length}`,
      );
    }
  }

  if (results.length) {
    console.error("History pagination issues detected:");
    for (const result of results.slice(0, 10)) {
      console.error(`- ${result.category} ${result.order}: ${result.issue}`);
      if (result.detail) {
        console.error(`  sample: ${JSON.stringify(result.detail)}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log("History pagination completed with no issues.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
