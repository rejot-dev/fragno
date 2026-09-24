#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const backofficeUrl = "http://localhost:5173";
const inspectorUrl = "http://localhost:9229";
const poemPrompt =
  "Write a narrative poem in exactly 150 numbered stanzas of four substantial lines each. Aim for 28,000 to 32,000 characters total. Stop after stanza 150; do not continue or add a preface or epilogue.";
const cliCommand = ["pnpm", "--filter", "@rejot-dev/backoffice-cli", "run", "backoffice-cli"];
const benchmarkAbort = new AbortController();
const activeProcesses = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    benchmarkAbort.abort(new Error(`Streaming heap benchmark: Interrupted by ${signal}.`));
    for (const handle of activeProcesses) {
      if (handle.child.pid && handle.child.exitCode === null && handle.child.signalCode === null) {
        try {
          process.kill(-handle.child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") {
            console.error(error);
          }
        }
      }
    }
  });
}
const traceDirectory = join(
  repoRoot,
  "apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store",
);
const defaultAuthFile = join(
  homedir(),
  ".local/state/fragno/backoffice-cli/streaming-heap-benchmark-auth.json",
);

function usage() {
  return `Usage: node apps/backoffice/scripts/benchmark-streaming-heap.mjs --json /tmp/streaming-heap.json [options]

Options:
  --runs N             Heap-only runs (default: 3)
  --post-ms N          Heap sampling after cleanup callback (default: 60000)
  --turn-timeout-ms N  Codemode request deadline (default: 300000)
  --model PROVIDER:NAME  Pi model (default: openai:gpt-5.6-luna)
  --scope org:SLUG     Organization scope (default: authenticated default organization)
  --prompt-file PATH   Prompt text (default: bounded 150-stanza long poem)
  --skip-isolated      Skip the fixed-workload workflow heap benchmark
  --heap-only          Skip the separate allocation-sampled full turn
  --skip-build         Use existing production bundles (iteration only)

Defaults to BACKOFFICE_EMAIL=\${USER}@rejot.dev and BACKOFFICE_PASSWORD=wachtwoord.
Override either with its environment variable. Requires a local AUTH_ADMIN_GRANT_TOKEN
(environment or apps/backoffice/.dev.vars) and a model API key.
First-time CLI OAuth login requires device approval in the browser. Uses only localhost.
Writes a JSON summary and owner-only raw artifacts beside it.`;
}

function parseArguments(args) {
  const options = {
    json: null,
    runs: 3,
    postMs: 60_000,
    turnTimeoutMs: 300_000,
    model: "openai:gpt-5.6-luna",
    scope: null,
    promptFile: null,
    includeIsolated: true,
    includeSampled: true,
    build: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--skip-isolated") {
      options.includeIsolated = false;
      continue;
    }
    if (argument === "--heap-only") {
      options.includeSampled = false;
      continue;
    }
    if (argument === "--skip-build") {
      options.build = false;
      continue;
    }
    const value = args[++index];
    if (!value) {
      throw new Error(`Streaming heap benchmark: Missing value for ${argument}.\n${usage()}`);
    }
    if (argument === "--json") {
      options.json = resolve(value);
    } else if (argument === "--runs") {
      options.runs = Number(value);
    } else if (argument === "--post-ms") {
      options.postMs = Number(value);
    } else if (argument === "--turn-timeout-ms") {
      options.turnTimeoutMs = Number(value);
    } else if (argument === "--model") {
      options.model = value;
    } else if (argument === "--scope") {
      options.scope = value;
    } else if (argument === "--prompt-file") {
      options.promptFile = resolve(value);
    } else {
      throw new Error(`Streaming heap benchmark: Unknown option ${argument}.\n${usage()}`);
    }
  }
  if (!options.json?.endsWith(".json") || !Number.isSafeInteger(options.runs) || options.runs < 1) {
    throw new Error(
      `Streaming heap benchmark: --json and a positive --runs are required.\n${usage()}`,
    );
  }
  if (!Number.isSafeInteger(options.postMs) || options.postMs < 0) {
    throw new Error("Streaming heap benchmark: --post-ms must be a nonnegative integer.");
  }
  if (
    !Number.isSafeInteger(options.turnTimeoutMs) ||
    options.turnTimeoutMs <= 10_000 ||
    options.turnTimeoutMs > 300_000
  ) {
    throw new Error(
      "Streaming heap benchmark: --turn-timeout-ms must be between 10001 and 300000.",
    );
  }
  const [provider, ...modelParts] = options.model.split(":");
  if (!["openai", "anthropic", "gemini"].includes(provider) || !modelParts.join(":")) {
    throw new Error(
      "Streaming heap benchmark: --model must be openai:NAME, anthropic:NAME, or gemini:NAME.",
    );
  }
  if (options.scope && !/^org:[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(options.scope)) {
    throw new Error("Streaming heap benchmark: --scope must be org:SLUG.");
  }
  return { ...options, provider, modelName: modelParts.join(":") };
}

function benchmarkAbortError() {
  const reason = benchmarkAbort.signal.reason;
  return reason instanceof Error
    ? reason
    : new Error("Streaming heap benchmark: Interrupted.", { cause: reason });
}

function wait(ms) {
  if (benchmarkAbort.signal.aborted) {
    return Promise.reject(benchmarkAbortError());
  }
  return new Promise((done, fail) => {
    const abort = () => {
      clearTimeout(timer);
      fail(benchmarkAbortError());
    };
    const timer = setTimeout(() => {
      benchmarkAbort.signal.removeEventListener("abort", abort);
      done();
    }, ms);
    benchmarkAbort.signal.addEventListener("abort", abort, { once: true });
  });
}

function startProcess(
  command,
  args,
  { env, cwd = repoRoot, stdout, stderr, inherit = false, capture = false } = {},
) {
  const child = spawn(command, args, {
    cwd,
    env: env ?? process.env,
    detached: true,
    stdio: [inherit ? "inherit" : "ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const outputs = [];
  if (stdout) {
    const destination = createWriteStream(stdout, { flags: "wx", mode: 0o600 });
    child.stdout.pipe(destination);
    outputs.push(finished(destination));
  } else {
    child.stdout.on("data", (chunk) => {
      if (capture) {
        output += chunk.toString();
      }
      if (inherit) {
        process.stdout.write(chunk);
      }
    });
  }
  if (stderr) {
    const destination = createWriteStream(stderr, { flags: "wx", mode: 0o600 });
    child.stderr.pipe(destination);
    outputs.push(finished(destination));
  } else {
    child.stderr.on("data", (chunk) => {
      errors = `${errors}${chunk.toString()}`.slice(-4_096);
      process.stderr.write(chunk);
    });
  }
  const exit = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      done({ code, signal });
    });
  }).then(async (result) => {
    await Promise.all(outputs);
    return result;
  });
  const handle = {
    child,
    exit,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
  activeProcesses.add(handle);
  void exit.then(
    () => {
      activeProcesses.delete(handle);
    },
    () => {
      activeProcesses.delete(handle);
    },
  );
  return handle;
}

async function runCommand(command, args, options = {}) {
  const processHandle = startProcess(command, args, {
    ...options,
    capture: options.capture ?? !options.inherit,
  });
  const exit = await processHandle.exit;
  if (benchmarkAbort.signal.aborted) {
    throw benchmarkAbort.signal.reason;
  }
  if (exit.code !== 0) {
    throw new Error(
      `Streaming heap benchmark: ${command} ${args.join(" ")} exited with ${exit.code ?? exit.signal}. ${processHandle.errors.slice(-1000)}`,
    );
  }
  return processHandle.output;
}

async function stopProcess(processHandle) {
  if (!processHandle) {
    return;
  }
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    await processHandle.exit;
    return;
  }
  try {
    process.kill(-processHandle.child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  await Promise.race([
    processHandle.exit,
    new Promise((done) => {
      setTimeout(done, 5_000);
    }),
  ]);
  if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) {
    try {
      process.kill(-processHandle.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await processHandle.exit;
}

async function writeSummary(path, result) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function waitForPreview(processHandle) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
      throw new Error("Streaming heap benchmark: Vite preview exited before becoming ready.");
    }
    try {
      const [app, targets] = await Promise.all([
        fetch(`${backofficeUrl}/`, { signal: AbortSignal.timeout(1_000), redirect: "manual" }),
        fetch(`${inspectorUrl}/json/list`, { signal: AbortSignal.timeout(1_000) }).then(
          (response) => response.json(),
        ),
      ]);
      if (
        app.status < 500 &&
        targets.some(
          (target) => new URL(target.webSocketDebuggerUrl).pathname.slice(1) === "rejot-backoffice",
        )
      ) {
        return;
      }
    } catch {
      /* Preview and inspector start independently. */
    }
    await wait(1_000);
  }
  throw new Error(
    "Streaming heap benchmark: Vite preview or rejot-backoffice inspector did not start within 120 seconds.",
  );
}

function parseCliResult(stdout) {
  const start = stdout.lastIndexOf('{\n  "ok":');
  if (start < 0) {
    throw new Error("Streaming heap benchmark: Backoffice CLI did not return codemode JSON.");
  }
  const response = JSON.parse(stdout.slice(start));
  if (response.ok !== true) {
    throw new Error(
      `Streaming heap benchmark: Backoffice codemode returned ${JSON.stringify(response.error)}`,
    );
  }
  return response.result;
}

async function runCodemode(scope, sourceFile, env) {
  return parseCliResult(
    await runCommand(
      cliCommand[0],
      [...cliCommand.slice(1), "exec", scope, "--file", sourceFile, "--timeout", "120000"],
      { env },
    ),
  );
}

async function loginToBenchmarkAccount(env, email) {
  async function login(force) {
    const args = [...cliCommand.slice(1), "login", "--open"];
    if (force) {
      args.push("--force");
    }
    const stdout = await runCommand(cliCommand[0], args, { env, inherit: true, capture: true });
    const start = stdout.lastIndexOf('{\n  "baseUrl":');
    if (start < 0) {
      throw new Error("Streaming heap benchmark: CLI login returned no account summary.");
    }
    return JSON.parse(stdout.slice(start));
  }
  let summary = await login(false);
  if (summary.user.email.toLowerCase() !== email.toLowerCase()) {
    console.error(
      `Streaming heap benchmark: Stored CLI login is ${summary.user.email}; approve ${email} instead.`,
    );
    summary = await login(true);
  }
  if (summary.user.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error(`Streaming heap benchmark: CLI login must belong to ${email}.`);
  }
  return summary;
}

async function currentOutboxVersionstamp(authFile, scope) {
  // The CLI just exchanged a JWT for this scope; read its owner-only state without logging the token.
  const auth = JSON.parse(await readFile(authFile, "utf8"));
  const credentials = auth.backoffice;
  if (
    auth.baseUrl !== backofficeUrl ||
    credentials?.scope?.kind !== "org" ||
    typeof credentials.scope.orgId !== "string" ||
    typeof credentials.accessToken !== "string"
  ) {
    throw new Error(
      "Streaming heap benchmark: CLI credentials are not scoped to the benchmark organization.",
    );
  }
  const response = await fetch(
    `${backofficeUrl}/api/automations-scoped/org/${encodeURIComponent(credentials.scope.orgId)}/_internal`,
    { headers: { authorization: `Bearer ${credentials.accessToken}` }, redirect: "manual" },
  );
  if (!response.ok) {
    throw new Error(
      `Streaming heap benchmark: Cannot read current outbox cursor for ${scope}: HTTP ${response.status}.`,
    );
  }
  const description = await response.json();
  if (
    description.currentVersionstamp !== null &&
    (typeof description.currentVersionstamp !== "string" ||
      !/^[0-9a-f]{24}$/i.test(description.currentVersionstamp))
  ) {
    throw new Error("Streaming heap benchmark: Invalid current outbox versionstamp.");
  }
  return description.currentVersionstamp;
}

async function waitForListener(listener, previewLog, logOffset) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (listener.child.exitCode !== null || listener.child.signalCode !== null) {
      throw new Error("Streaming heap benchmark: Outbox listener exited before connecting.");
    }
    const log = await readFile(previewLog, "utf8");
    if (log.slice(logOffset).includes("fragno.outbox_stream.started")) {
      return;
    }
    await wait(250);
  }
  throw new Error(
    "Streaming heap benchmark: Outbox listener did not open its stream within 10 seconds.",
  );
}

function summarizeOutbox(content) {
  let records = 0;
  let bytes = 0;
  let truncateCount = 0;
  let truncatedIds = 0;
  let finalVersionstamp = null;
  // A live listener may have written only part of its last NDJSON line.
  for (const line of content.slice(0, content.lastIndexOf("\n") + 1).split("\n")) {
    if (!line.startsWith('{"id":')) {
      continue;
    }
    const entry = JSON.parse(line);
    if (typeof entry.versionstamp !== "string" || !/^[0-9a-f]{24}$/i.test(entry.versionstamp)) {
      throw new Error("Streaming heap benchmark: Invalid listener outbox versionstamp.");
    }
    records += 1;
    bytes += Buffer.byteLength(`${line}\n`);
    finalVersionstamp = entry.versionstamp;
    for (const operation of entry.payload?.json?.operations ?? []) {
      if (operation.op === "truncate") {
        truncateCount += 1;
        truncatedIds += operation.externalIds?.length ?? 0;
      }
    }
  }
  return { records, bytes, truncateCount, truncatedIds, finalVersionstamp };
}

async function waitForOutboxListener(listener, outboxFile, targetVersionstamp) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (listener.child.exitCode !== null || listener.child.signalCode !== null) {
      throw new Error("Streaming heap benchmark: Outbox listener exited before catching up.");
    }
    const outbox = summarizeOutbox(await readFile(outboxFile, "utf8"));
    if (outbox.finalVersionstamp !== null && outbox.finalVersionstamp >= targetVersionstamp) {
      return outbox;
    }
    await wait(1_000);
  }
  throw new Error(
    `Streaming heap benchmark: Outbox listener did not reach ${targetVersionstamp} within 60 seconds.`,
  );
}

async function findCleanupTraces(cleanupStartedMs, cleanupCompletedMs) {
  const databases = (await readdir(traceDirectory)).filter(
    (file) => file.endsWith(".sqlite") && file !== "metadata.sqlite",
  );
  if (databases.length !== 1) {
    throw new Error(
      `Streaming heap benchmark: Expected one local trace database in ${traceDirectory}.`,
    );
  }
  const db = new DatabaseSync(join(traceDirectory, databases[0]), { readOnly: true });
  try {
    const candidates = db
      .prepare(`
      SELECT alarm.trace_id AS traceId, alarm.start_ms AS startMs, alarm.duration_ms AS durationMs
      FROM spans alarm
      WHERE alarm.name = 'alarm' AND alarm.start_ms BETWEEN ? AND ?
      ORDER BY alarm.start_ms ASC
    `)
      .all(cleanupStartedMs - 5_000, cleanupCompletedMs + 5_000);
    const countDeletes = db.prepare(`
      SELECT COUNT(*) AS deletes FROM spans
      WHERE trace_id = ? AND name = 'durable_object_storage_exec'
        AND json_extract(json(attributes), '$."db.query.text"')
            LIKE 'delete from "workflow_step_emission_workflows"%'
    `);
    // One cleanup spans multiple alarms; hook attributes may be absent in large traces.
    const storageTransactions = db.prepare(`
      SELECT MAX(start_ms + duration_ms) AS finishedAt, MAX(duration_ms) AS longestMs,
        COUNT(*) AS total, COUNT(*) FILTER (WHERE duration_ms IS NULL) AS pending
      FROM spans WHERE trace_id = ? AND name = 'durable_object_storage_transaction'
    `);
    const terminalAlarm = candidates.findLast(
      (alarm) =>
        alarm.startMs <= cleanupCompletedMs &&
        (alarm.durationMs === null || alarm.startMs + alarm.durationMs >= cleanupCompletedMs),
    );
    const alarms = candidates.flatMap((alarm) => {
      const { deletes } = countDeletes.get(alarm.traceId);
      if (deletes === 0) {
        return [];
      }
      const storage = storageTransactions.get(alarm.traceId);
      return [{ ...alarm, deletes, storage }];
    });
    const terminalTrace = alarms.find((alarm) => alarm.traceId === terminalAlarm?.traceId);
    if (
      !terminalTrace ||
      terminalTrace.durationMs === null ||
      terminalTrace.storage.total === 0 ||
      terminalTrace.storage.pending > 0 ||
      terminalTrace.storage.finishedAt === null
    ) {
      // The final callback can log before its alarm's storage transaction completes.
      return null;
    }
    return {
      firstTraceId: alarms[0].traceId,
      lastTraceId: alarms.at(-1).traceId,
      alarmCount: alarms.length,
      startedAtEpochMs: cleanupStartedMs,
      finishedAtEpochMs: Math.max(
        cleanupCompletedMs,
        ...alarms.map((alarm) => alarm.storage.finishedAt ?? 0),
      ),
      durationMs: cleanupCompletedMs - cleanupStartedMs,
      longestStorageTransactionDurationMs: Math.max(
        ...alarms.map((alarm) => alarm.storage.longestMs ?? 0),
      ),
      longestAlarmSpanMs: Math.max(...alarms.map((alarm) => alarm.durationMs)),
      observedDeleteSpans: alarms.reduce((total, alarm) => total + alarm.deletes, 0),
    };
  } finally {
    db.close();
  }
}

async function waitForCleanupTraces(cleanupStartedMs, cleanupCompletedMs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const traces = await findCleanupTraces(cleanupStartedMs, cleanupCompletedMs);
      if (traces) {
        return traces;
      }
    } catch (error) {
      if (attempt === 59) {
        throw error;
      }
    }
    await wait(1_000);
  }
  throw new Error(
    "Streaming heap benchmark: Terminal cleanup storage traces did not complete within 60 seconds.",
  );
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

async function benchmarkTurn({
  mode,
  index,
  artifactDirectory,
  scope,
  env,
  model,
  prompt,
  previewLog,
  postMs,
  turnTimeoutMs,
}) {
  const prefix = join(artifactDirectory, `${mode}-${index}`);
  const createFile = `${prefix}.create-session.js`;
  await writeFile(
    createFile,
    `async () => await pi.createSession(${JSON.stringify({
      model,
      name: `Streaming heap benchmark ${mode} ${index}`,
      tags: ["streaming-heap-benchmark"],
    })})\n`,
    { mode: 0o600 },
  );
  const session = await runCodemode(scope, createFile, env);
  if (typeof session.id !== "string") {
    throw new Error("Streaming heap benchmark: Pi session creation returned no ID.");
  }
  const cursor = await currentOutboxVersionstamp(env.BACKOFFICE_AUTH_FILE, scope);
  const outboxFile = `${prefix}.outbox.ndjson`;
  const outboxErrors = `${prefix}.outbox.stderr`;
  const logOffset = (await readFile(previewLog, "utf8")).length;
  const listenArgs = [...cliCommand.slice(1), "listen", scope];
  if (cursor) {
    listenArgs.push("--after-versionstamp", cursor);
  }
  const listener = startProcess(cliCommand[0], listenArgs, {
    env,
    stdout: outboxFile,
    stderr: outboxErrors,
  });
  try {
    await waitForListener(listener, previewLog, logOffset);
    const turnFile = `${prefix}.turn.js`;
    await writeFile(
      turnFile,
      `async () => {
  const turn = await pi.runTurn(${JSON.stringify({ sessionId: session.id, text: prompt, timeoutMs: turnTimeoutMs - 10_000 })});
  return {
    sessionId: turn.id,
    assistantCharacters: turn.assistantText.length,
    commandStatus: turn.commandStatus,
    workflowStatus: turn.workflow.status,
  };
}\n`,
      { mode: 0o600 },
    );
    await runCommand(
      "node",
      [
        "apps/backoffice/scripts/profile-streaming-heap.mjs",
        "--mode",
        mode,
        "--output",
        prefix,
        "--post-ms",
        String(postMs),
        "--marker-timeout-ms",
        String(turnTimeoutMs + 60_000),
        "--",
        cliCommand[0],
        ...cliCommand.slice(1),
        "exec",
        scope,
        "--file",
        turnFile,
        "--timeout",
        String(turnTimeoutMs),
      ],
      { env },
    );
    if (listener.child.exitCode !== null || listener.child.signalCode !== null) {
      throw new Error(
        `Streaming heap benchmark: Outbox listener disconnected during ${session.id}.`,
      );
    }
    const profile = JSON.parse(await readFile(`${prefix}.summary.json`, "utf8"));
    const turn = parseCliResult(await readFile(`${prefix}.stdout`, "utf8"));
    if (
      turn.sessionId !== session.id ||
      turn.assistantCharacters < 1 ||
      turn.workflowStatus === "errored" ||
      turn.commandStatus === "errored"
    ) {
      throw new Error(
        `Streaming heap benchmark: Pi turn did not finish successfully for ${session.id}.`,
      );
    }
    const cleanupStart = profile.markers.find(
      (marker) => marker.event === "fragno.workflow_step_emissions_cleanup.started",
    );
    if (!cleanupStart) {
      throw new Error(
        `Streaming heap benchmark: Missing terminal cleanup marker for ${session.id}.`,
      );
    }
    const cleanupComplete = profile.markers.find(
      (marker) => marker.event === "fragno.workflow_step_emissions_cleanup.completed",
    );
    if (!cleanupComplete) {
      throw new Error(`Streaming heap benchmark: Missing final cleanup marker for ${session.id}.`);
    }
    const cleanup = await waitForCleanupTraces(
      cleanupStart.consoleEpochMs,
      cleanupComplete.consoleEpochMs,
    );
    const memorySamples = (await readFile(`${prefix}.memory.tsv`, "utf8")).trim().split("\n");
    const finalSampleOffsetMs = Number(memorySamples.at(-1).split("\t")[0]);
    if (!Number.isFinite(finalSampleOffsetMs)) {
      throw new Error(`Streaming heap benchmark: No heap samples for ${session.id}.`);
    }
    if (cleanup.finishedAtEpochMs > profile.startedAtEpochMs + finalSampleOffsetMs) {
      throw new Error(
        `Streaming heap benchmark: Cleanup storage for ${session.id} outlasted heap sampling; increase --post-ms.`,
      );
    }
    const targetVersionstamp = await currentOutboxVersionstamp(env.BACKOFFICE_AUTH_FILE, scope);
    if (targetVersionstamp === null) {
      throw new Error("Streaming heap benchmark: Cleanup produced no outbox versionstamp.");
    }
    const outbox = await waitForOutboxListener(listener, outboxFile, targetVersionstamp);
    if (outbox.truncateCount === 0) {
      throw new Error(`Streaming heap benchmark: No cleanup truncate reached ${session.id}.`);
    }
    return {
      mode,
      index,
      sessionId: session.id,
      assistantCharacters: turn.assistantCharacters,
      commandStatus: turn.commandStatus,
      baselineUsedBytes: profile.baseline.usedSize,
      peakUsedBytes: profile.peakUsedBytes,
      peakIncreaseBytes: profile.peakUsedBytes - profile.baseline.usedSize,
      sampledAllocationBytes:
        mode === "sampled" ? profile.byPhase.streaming.allocation.sampledAllocationBytes : null,
      cleanup,
      outbox,
      artifacts: {
        profile: `${prefix}.summary.json`,
        memory: `${prefix}.memory.tsv`,
        outbox: outboxFile,
        listenerErrors: outboxErrors,
        sampledStreaming: mode === "sampled" ? `${prefix}.streaming.allocation.json` : null,
      },
    };
  } finally {
    await stopProcess(listener);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const email =
    process.env.BACKOFFICE_EMAIL?.trim() ||
    `${process.env.USER?.trim() || userInfo().username}@rejot.dev`;
  const password = process.env.BACKOFFICE_PASSWORD || "wachtwoord";
  if (!email.toLowerCase().endsWith("@rejot.dev")) {
    throw new Error("Streaming heap benchmark: BACKOFFICE_EMAIL must be a @rejot.dev address.");
  }
  const jsonFile = options.json;
  const artifactDirectory = `${jsonFile.slice(0, -5)}.artifacts`;
  await mkdir(dirname(jsonFile), { recursive: true });
  await mkdir(artifactDirectory, { mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const env = {
    ...process.env,
    BACKOFFICE_URL: backofficeUrl,
    WORKERD_CDP_URL: inspectorUrl,
    BACKOFFICE_EMAIL: email,
    BACKOFFICE_PASSWORD: password,
    BACKOFFICE_AUTH_FILE: process.env.BACKOFFICE_AUTH_FILE || defaultAuthFile,
  };
  const prompt = options.promptFile ? await readFile(options.promptFile, "utf8") : poemPrompt;
  if (!prompt.trim()) {
    throw new Error("Streaming heap benchmark: Prompt is empty.");
  }
  const model = { provider: options.provider, name: options.modelName };
  const commit = (await runCommand("git", ["rev-parse", "HEAD"])).trim();
  const dirtyFiles = (await runCommand("git", ["status", "--porcelain"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    artifactDirectory,
    source: { commit, dirtyFiles, nodeVersion: process.version },
    workload: {
      model,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      scope: null,
      listenerCount: 1,
      heapRuns: options.runs,
      sampled: options.includeSampled,
      postMs: options.postMs,
      turnTimeoutMs: options.turnTimeoutMs,
    },
    isolated: null,
    runs: [],
    heapOnlyMedianPeakUsedBytes: null,
    heapOnlyOutputComparable: null,
    error: null,
  };
  await writeSummary(jsonFile, report);
  let preview;
  try {
    let localVars = "";
    try {
      localVars = await readFile(join(repoRoot, "apps/backoffice/.dev.vars"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (!env.AUTH_ADMIN_GRANT_TOKEN && !/^AUTH_ADMIN_GRANT_TOKEN=.+$/m.test(localVars)) {
      throw new Error(
        "Streaming heap benchmark: Configure AUTH_ADMIN_GRANT_TOKEN for the local admin grant before building.",
      );
    }
    for (const url of [`${backofficeUrl}/`, `${inspectorUrl}/json/list`]) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1_000) });
      } catch (error) {
        const cause = error.cause;
        if (
          cause?.code !== "ECONNREFUSED" &&
          !(
            cause instanceof AggregateError &&
            cause.errors.length > 0 &&
            cause.errors.every((failure) => failure.code === "ECONNREFUSED")
          )
        ) {
          throw error;
        }
        continue;
      }
      throw new Error(
        `Streaming heap benchmark: ${url} is already in use; stop that server first.`,
      );
    }
    if (options.build) {
      const filters = ["@fragno-apps/backoffice-rr", "@rejot-dev/backoffice-cli"];
      if (options.includeIsolated) {
        filters.push("@fragno-private/workflows-heap-benchmark");
      }
      await runCommand(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          ...filters.map((filter) => `--filter=${filter}`),
          "--output-logs=errors-only",
        ],
        { inherit: true },
      );
    }
    if (options.includeIsolated) {
      const isolatedFile = join(artifactDirectory, "workflows-heap.json");
      await runCommand(
        "pnpm",
        [
          "--filter",
          "@fragno-private/workflows-heap-benchmark",
          "measure",
          "--",
          "--mode",
          "both",
          "--histories",
          "100,10000",
          "--runs",
          "3",
          "--batch-count",
          "30",
          "--emissions-per-batch",
          "10",
          "--payload-bytes",
          "256",
          "--interval-ms",
          "125",
          "--json",
          isolatedFile,
        ],
        { inherit: true },
      );
      report.isolated = {
        artifact: isolatedFile,
        medians: JSON.parse(await readFile(isolatedFile, "utf8")).medians,
      };
      await writeSummary(jsonFile, report);
    }
    const previewLog = join(artifactDirectory, "preview.log");
    preview = startProcess(
      "node",
      ["scripts/run-vite-preview.mjs", "--host", "localhost", "--port", "5173", "--strictPort"],
      {
        cwd: join(repoRoot, "apps/backoffice"),
        stdout: previewLog,
        stderr: join(artifactDirectory, "preview.stderr"),
        env,
      },
    );
    await waitForPreview(preview);
    await runCommand("bash", ["apps/backoffice/scripts/create-dev-account.sh"], {
      env,
      inherit: true,
    });
    await runCommand("bash", ["apps/backoffice/scripts/grant-admin.sh", "--local", email], {
      env,
      inherit: true,
    });
    const account = await loginToBenchmarkAccount(env, email);
    const scope =
      options.scope ??
      (account.defaultScope?.startsWith("org:")
        ? account.defaultScope
        : account.scopes.find((candidate) => candidate.argument.startsWith("org:"))?.argument);
    if (!scope || !account.scopes.some((candidate) => candidate.argument === scope)) {
      throw new Error(
        "Streaming heap benchmark: No accessible organization scope; run backoffice scopes.",
      );
    }
    report.workload.scope = scope;
    await writeSummary(jsonFile, report);
    for (let index = 1; index <= options.runs + Number(options.includeSampled); index += 1) {
      const mode = index <= options.runs ? "heap-only" : "sampled";
      console.error(
        `Streaming heap benchmark: ${mode} ${index <= options.runs ? index : 1}/${mode === "sampled" ? 1 : options.runs}`,
      );
      const run = await benchmarkTurn({
        mode,
        index: mode === "sampled" ? 1 : index,
        artifactDirectory,
        scope,
        env,
        model,
        prompt,
        previewLog,
        postMs: options.postMs,
        turnTimeoutMs: options.turnTimeoutMs,
      });
      report.runs.push(run);
      const peaks = report.runs
        .filter((item) => item.mode === "heap-only")
        .map((item) => item.peakUsedBytes);
      report.heapOnlyMedianPeakUsedBytes = median(peaks);
      const characterCounts = report.runs
        .filter((item) => item.mode === "heap-only")
        .map((item) => item.assistantCharacters);
      const minimum = Math.min(...characterCounts);
      const maximum = Math.max(...characterCounts);
      report.heapOnlyOutputComparable = {
        minimumCharacters: minimum,
        maximumCharacters: maximum,
        lengthRatio: minimum / maximum,
        comparable: minimum >= 20_000 && minimum / maximum >= 0.8,
      };
      await writeSummary(jsonFile, report);
    }
    report.status = "ok";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await stopProcess(preview);
    await writeSummary(jsonFile, report);
    console.error(`Streaming heap benchmark: ${jsonFile}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
