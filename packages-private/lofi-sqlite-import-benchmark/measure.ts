// Runs one import in headless Chrome with a fresh profile, so OPFS starts empty, and prints the
// page's results JSON: `node measure.ts <chrome> <page url> views|no-views`.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chromePath, pageUrl, viewsArgument] = process.argv.slice(2);
if (!chromePath || !pageUrl || (viewsArgument !== "views" && viewsArgument !== "no-views")) {
  throw new Error("Usage: node measure.ts <chrome> <page url> views|no-views");
}
const DEBUGGING_PORT = 9447;
const TIMEOUT_MS = 30 * 60_000;

const profile = await mkdtemp(join(tmpdir(), "lofi-sqlite-benchmark-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUGGING_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  const page = await openPage();
  await page.send("Page.navigate", { url: pageUrl });
  await waitFor(page, `!document.getElementById("import").disabled`);
  await page.evaluate(
    `document.getElementById("views").checked = ${viewsArgument === "views"};
     document.getElementById("import").click();`,
  );
  const startedAt = Date.now();
  while (true) {
    await sleep(5_000);
    const progress = (await page.evaluate(
      `({ stats: document.getElementById("stats").innerText,
          errors: document.getElementById("errors").innerText,
          done: !document.getElementById("copy").disabled })`,
    )) as { stats: string; errors: string; done: boolean };
    if (progress.errors) {
      throw new Error(progress.errors);
    }
    if (progress.done) {
      break;
    }
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error(`The import did not finish in ${TIMEOUT_MS / 60_000} minutes.`);
    }
    const applied = /Applied\t([^\n]*)/u.exec(progress.stats)?.[1] ?? "starting";
    console.error(`${Math.round((Date.now() - startedAt) / 1000)} s: ${applied}`);
  }
  // The page's own results, plus Chrome's version, which the user agent hides in headless mode.
  const version = (await (
    await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json/version`)
  ).json()) as {
    Browser: string;
  };
  const results = (await page.evaluate(
    `JSON.stringify(window.lofiSqliteBenchmarkResults())`,
  )) as string;
  console.log(JSON.stringify({ browser: version.Browser, ...JSON.parse(results) }, null, 2));
  page.close();
} finally {
  // Chrome writes to its profile while it shuts down, so the profile goes only after it exits.
  const exited = once(chrome, "exit");
  chrome.kill();
  await exited;
  await rm(profile, { recursive: true, force: true });
}

type Page = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
};

/** Connects to the first tab over the DevTools protocol once Chrome accepts connections. */
async function openPage(): Promise<Page> {
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> | undefined;
  for (let attempt = 0; !targets; attempt++) {
    try {
      targets = (await (
        await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json`)
      ).json()) as typeof targets;
    } catch (error) {
      if (attempt === 50) {
        throw error;
      }
      await sleep(200);
    }
  }
  const socket = new WebSocket(targets.find(({ type }) => type === "page")!.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    socket.addEventListener("open", resolve, { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) {
      throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    }
    return reply.result;
  };
  return {
    send,
    async evaluate(expression) {
      const { result, exceptionDetails } = (await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result: { value: unknown }; exceptionDetails?: unknown };
      if (exceptionDetails) {
        throw new Error(JSON.stringify(exceptionDetails));
      }
      return result.value;
    },
    close() {
      socket.close();
    },
  };
}

/** Polls until `expression` is true; the page is ready once its module has fetched the fixture. */
async function waitFor(page: Page, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      if (await page.evaluate(expression)) {
        return;
      }
    } catch {
      // The page has not loaded yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
