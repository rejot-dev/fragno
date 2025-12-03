import { test, expect, afterAll, beforeAll, describe } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env.ci when running in CI environment
if (process.env["CI"]) {
  config({ path: resolve(process.cwd(), ".env.ci") });
}

// FIXME: This test is slow, it takes a long time for the dev server to start on CI
// but I couldn't get the async_hooks to be included in a
// developement build using `vite build -m development`.
// Feel free to remove this down the line when we are more certain this issue won't pop up again.
describe("development server integration", () => {
  let devServer: ChildProcess;
  let serverLogs: string[] = [];
  const PORT = 3000;
  const BASE_URL = `http://localhost:${PORT}`;
  const CHECK_URL = `${BASE_URL}/check`;

  beforeAll(async () => {
    // Start the dev server
    devServer = spawn("pnpm", ["run", "dev", "--port", PORT.toString()], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stdout and stderr
    devServer.stdout?.on("data", (data) => {
      serverLogs.push(`[stdout] ${data.toString()}`);
    });
    devServer.stderr?.on("data", (data) => {
      serverLogs.push(`[stderr] ${data.toString()}`);
    });

    // Poll for server readiness
    await new Promise((resolve) => setTimeout(resolve, 500));

    const startTime = Date.now();
    const timeout = 10000;
    const pollInterval = 200;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(BASE_URL);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet, continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    console.error("Server failed to start. Server logs:");
    console.error(serverLogs.join("\n"));
    throw new Error(`Server did not respond with 200 OK within ${timeout}ms`);
  }, 60000);

  afterAll(() => {
    if (devServer) {
      devServer.kill("SIGTERM");
      setTimeout(() => {
        if (devServer && !devServer.killed) {
          devServer.kill("SIGKILL");
        }
      }, 2000);
    }
  });

  test("should not throw async_hooks externalization error", async () => {
    let response: Response;
    try {
      response = await fetch(CHECK_URL);
    } catch (error) {
      console.error("Failed to fetch from dev server. Server logs:");
      console.error(serverLogs.join("\n"));
      throw error;
    }

    if (response.status !== 200) {
      console.error(`Unexpected status ${response.status}. Server logs:`);
      console.error(serverLogs.join("\n"));
    }

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);

    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("text/html");

    const html = await response.text();

    // Check that the HTML doesn't contain the async_hooks error
    expect(html).not.toContain("node:async_hooks");
    expect(html).not.toContain("has been externalized for browser compatibility");
    expect(html).not.toContain("AsyncLocalStorage");
  });
});
