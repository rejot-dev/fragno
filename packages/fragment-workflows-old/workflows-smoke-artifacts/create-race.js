const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const attempts = Number(process.env.ATTEMPTS ?? 5);

if (!Number.isFinite(attempts) || attempts <= 0) {
  throw new Error(`Invalid ATTEMPTS: ${process.env.ATTEMPTS}`);
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
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function main() {
  const id = `race_${Date.now().toString(36)}`;
  console.log(`Creating ${attempts} concurrent requests for ${id}`);

  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      request(`/approval-workflow/instances`, {
        method: "POST",
        body: JSON.stringify({
          id,
          params: { requestId: `req_${id}`, amount: 100, requestedBy: "race" },
        }),
      }),
    ),
  );

  const summary = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log("Status summary:", summary);

  const okCount = results.filter((r) => r.status >= 200 && r.status < 300).length;
  if (okCount !== 1) {
    console.error(`Expected exactly 1 success, saw ${okCount}`);
    results.forEach((r, i) => console.error(`#${i + 1} -> ${r.status}:`, r.body));
    process.exit(1);
  }

  const instance = await request(`/approval-workflow/instances/${id}`, { method: "GET" });
  if (instance.status !== 200) {
    console.error(`Instance lookup failed: ${instance.status}`, instance.body);
    process.exit(1);
  }

  console.log("Create race completed with expected results.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
