import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import type { Reporter, TestModule, Vitest } from "vitest/node";

/*
 * INVESTIGATION: intermittent hang of Backoffice test runs (October 2026)
 *
 * This watchdog exists because we are chasing one specific hang. Every stall report points here;
 * add what each new report teaches us.
 *
 * Symptom
 *   `pnpm test:changed` or `vitest run` stops making progress and only ends when something kills it
 *   (once after a 60-minute agent tool timeout). Every test file, Cloudflare ones included, has
 *   reported its results, but the summary never prints. Vitest (node) and its `workerd` child both
 *   idle in their event loops at 0% CPU, with their TCP connection still open. Seen twice in
 *   two days, both times in a full or changed run while another worktree ran its tests at the
 *   same time.
 *
 * Where it hangs
 *   Before teardown. Vitest's `exit()` force-quits after `teardownTimeout` (10s), and that never
 *   happened, so the run itself never finished. The Workers pool (`@cloudflare/vitest-plugin`
 *   1.3.6, Vitest 4.1.11) waits without a timeout for workerd to report each test file over a
 *   WebSocket; our working theory is that the final message for a file is lost.
 *
 * Ruled out
 *   - Interference between workerd instances: each Miniflare instance uses its own random temp
 *     directory and OS-assigned ports, Durable Objects are ephemeral, and no dev registry is
 *     configured, so instances share no state.
 *   - A hanging test: the stuck runs had results for every test.
 *   - Reproduction on an idle machine: 15 runs of the Cloudflare project alone and 8 full runs in a
 *     loop all finished normally (about 20s and 66s).
 *
 * Suspects
 *   - A race in the pool's shutdown that machine load exposes.
 *   - Teardown noise every Cloudflare run prints, hung or not: "Cannot perform I/O on behalf of a
 *     different Durable Object (I/O type: SpanParent)", `EnvironmentTeardownError: Closing rpc
 *     while "onUserConsoleLog" was pending`, and uncaught `NATIVE_WORKFLOW_RPC_FAILURE_AFTER_RETRY`.
 *
 * Watchdog behavior
 *   After 120 seconds without a progress event, the watchdog prints a report, writes diagnostics
 *   to `join(tmpdir(), "vitest-stall-<time>")` (`$TMPDIR/vitest-stall-<time>/` on macOS), kills the
 *   run's child processes, and exits with a failure. Watch mode and debugger sessions are exempt.
 *   - `VITEST_STALL_KEEP_ALIVE=1` reports without killing anything, so you can attach to the
 *     stalled processes.
 *   - `VITEST_STALL_TIMEOUT_SECONDS=<n>` changes the 120-second limit.
 *
 * What to look for in a stall report
 *   - `report.txt`: the last progress event, unfinished test files with finished/reported test
 *     counts, child processes, and open event-loop resources. A file whose tests are all finished
 *     but which never ended confirms the lost message; unfinished tests point to a hanging test.
 *   - `<pid>.sample.txt`: native stacks of each child process, such as workerd, showing whether
 *     it idles or waits on something specific (macOS only).
 *   - `node-report.json`: a Node.js diagnostic report of Vitest, including its open sockets and
 *     handles toward workerd.
 *
 * Remove this watchdog once the hang is understood and fixed upstream or here.
 */

// The longest Backoffice test timeout is 35 seconds, and nothing else keeps a healthy run silent
// this long.
const DEFAULT_STALL_SECONDS = 120;

interface ProcessInfo {
  pid: number;
  ppid: number;
  line: string;
}

/**
 * Ends a `vitest run` that stops reporting progress. The Workers pool waits without a timeout for
 * workerd to report that a test file finished; when that message is lost the run idles forever, and
 * Vitest's `teardownTimeout` never applies because the run never reaches teardown. The watchdog
 * writes a diagnostic report, kills the run's child processes, and exits with a failure.
 *
 * A plugin rather than a configured reporter, because `--reporter` on the command line replaces
 * configured reporters.
 */
export function stallWatchdog(): Plugin {
  return {
    name: "backoffice:stall-watchdog",
    configureVitest({ vitest }) {
      // Every project registers this plugin, but one watchdog covers the whole run. Watch mode and
      // debugger sessions are legitimately idle.
      if (vitest.config.watch || vitest.config.inspector.enabled) {
        return;
      }
      if (vitest.config.reporters.some((reporter) => reporter instanceof StallWatchdog)) {
        return;
      }
      vitest.config.reporters.push(
        new StallWatchdog(
          vitest,
          Number(process.env.VITEST_STALL_TIMEOUT_SECONDS ?? DEFAULT_STALL_SECONDS) * 1000,
          process.env.VITEST_STALL_KEEP_ALIVE === "1",
        ),
      );
    },
  };
}

class StallWatchdog implements Reporter {
  readonly #modules = new Map<string, TestModule>();
  #lastEvent = { label: "run not started", at: Date.now() };
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly vitest: Vitest,
    private readonly stallMs: number,
    private readonly keepAlive: boolean,
  ) {}

  onTestRunStart() {
    this.#modules.clear();
    this.#touch("run started");
  }

  onTestModuleQueued(testModule: TestModule) {
    this.#modules.set(testModule.moduleId, testModule);
    this.#touch(`queued ${this.#name(testModule)}`);
  }

  onTestModuleCollected(testModule: TestModule) {
    this.#touch(`collected ${this.#name(testModule)}`);
  }

  onTestModuleStart(testModule: TestModule) {
    this.#touch(`started ${this.#name(testModule)}`);
  }

  onTestModuleEnd(testModule: TestModule) {
    this.#modules.delete(testModule.moduleId);
    this.#touch(`finished ${this.#name(testModule)}`);
  }

  onTestCaseReady() {
    this.#touch(this.#lastEvent.label);
  }

  onTestCaseResult() {
    this.#touch(this.#lastEvent.label);
  }

  onHookStart() {
    this.#touch(this.#lastEvent.label);
  }

  onHookEnd() {
    this.#touch(this.#lastEvent.label);
  }

  onTestRunEnd() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #touch(label: string) {
    this.#lastEvent = { label, at: Date.now() };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#stalled();
    }, this.stallMs);
  }

  #name(testModule: TestModule) {
    return `|${testModule.project.name}| ${testModule.relativeModuleId}`;
  }

  #stalled() {
    const directory = join(
      tmpdir(),
      `vitest-stall-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    mkdirSync(directory, { recursive: true });
    const descendants = descendantProcesses(process.pid);
    const report = [
      `Vitest made no progress for ${this.stallMs / 1000}s.`,
      "We added this watchdog to investigate an intermittent hang of Backoffice test runs. See the",
      "INVESTIGATION notes in apps/backoffice/vitest.stall-watchdog.ts for what we already know,",
      "and add what this report shows.",
      "",
      `Last event ${Math.round((Date.now() - this.#lastEvent.at) / 1000)}s ago: ${this.#lastEvent.label}`,
      "",
      "Unfinished test files (tests finished/reported):",
      ...[...this.#modules.values()].map((testModule) => {
        const tests = [...testModule.children.allTests()];
        const finished = tests.filter((test) => test.result().state !== "pending").length;
        return `  ${testModule.state().padEnd(7)} ${finished}/${tests.length} ${this.#name(testModule)}`;
      }),
      "",
      `Child processes of Vitest (pid ${process.pid}):`,
      ...descendants.map((child) => `  ${child.line}`),
      "",
      `Event loop resources: ${process.getActiveResourcesInfo().join(", ")}`,
    ].join("\n");
    writeFileSync(join(directory, "report.txt"), `${report}\n`);
    // Lists open sockets and handles, which shows the connections to workerd still waiting.
    process.report.writeReport(join(directory, "node-report.json"));
    for (const child of descendants) {
      captureStack(child.pid, directory);
    }
    this.vitest.logger.error(`\n${report}\n\nStall diagnostics: ${directory}`);

    if (this.keepAlive) {
      this.vitest.logger.error(
        "VITEST_STALL_KEEP_ALIVE=1: leaving the stalled run alive to inspect.",
      );
      return;
    }
    for (const child of descendants) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    process.exit(1);
  }
}

function descendantProcesses(rootPid: number): ProcessInfo[] {
  const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,%cpu=,rss=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
      return { pid, ppid, line: line.trim().slice(0, 300) };
    });
  const descendants: ProcessInfo[] = [];
  // Skip the `ps` that produced this listing.
  const ps = processes.find((candidate) => candidate.line.includes("ps -A -o pid="));
  const parents = new Set([rootPid]);
  for (let found = true; found; ) {
    found = false;
    for (const candidate of processes) {
      if (candidate !== ps && parents.has(candidate.ppid) && !parents.has(candidate.pid)) {
        parents.add(candidate.pid);
        descendants.push(candidate);
        found = true;
      }
    }
  }
  return descendants;
}

/** Native stacks show where workerd or a worker process waits. Only macOS ships a sampler. */
function captureStack(pid: number, directory: string) {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    execFileSync("sample", [String(pid), "2", "-file", join(directory, `${pid}.sample.txt`)], {
      stdio: "ignore",
    });
  } catch {
    // The process exited or cannot be sampled; the report still lists it.
  }
}
