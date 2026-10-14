import type { SandboxExecRequest } from "./sandbox-container-contract";

export const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
export const COMMAND_KILL_GRACE_MS = 5_000;

// Both sandbox images include Node. Keep the supervisor outside the command's process group so it
// survives forced termination and reports the cause independently of the command's exit status.
const COMMAND_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const { argv, timeoutMs, limitBytes, killGraceMs } = JSON.parse(process.argv[1]);
const child = spawn(argv[0], argv.slice(1), {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const chunks = [[], []];
let outputBytes = 0;
let exitCode = null;
let endedStreams = 0;
let timedOut = false;
let finished = false;
let deadlineTimer;
let killTimer;
const deadline = performance.now() + timeoutMs;

function signalCommand(signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // The group can disappear between observing its exit and sending the cleanup signal.
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

function finish(outcome) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(deadlineTimer);
  clearTimeout(killTimer);
  child.stdout.destroy();
  child.stderr.destroy();
  process.stdout.write(JSON.stringify(outcome), () => process.exit(0));
}

function commandOutput() {
  return {
    stdout: Buffer.concat(chunks[0]).toString("utf8"),
    stderr: Buffer.concat(chunks[1]).toString("utf8"),
  };
}

function completeCommand() {
  if (finished || exitCode === null || endedStreams !== 2) {
    return;
  }
  if (timedOut) {
    signalCommand("SIGKILL");
    finish({ status: "timed_out", ...commandOutput() });
    return;
  }
  finish({ status: "exited", exitCode, ...commandOutput() });
}

function expireCommand() {
  if (finished || timedOut) {
    return;
  }
  timedOut = true;
  signalCommand("SIGTERM");
  killTimer = setTimeout(() => {
    signalCommand("SIGKILL");
    finish({ status: "timed_out", ...commandOutput() });
  }, killGraceMs);
}

function checkDeadline() {
  const remainingMs = deadline - performance.now();
  if (remainingMs > 0) {
    deadlineTimer = setTimeout(checkDeadline, Math.min(remainingMs, 2_147_483_647));
    return;
  }
  expireCommand();
}

function fail(error) {
  signalCommand("SIGKILL");
  console.error(error);
  process.exit(1);
}

for (const [index, stream] of [child.stdout, child.stderr].entries()) {
  stream.on("data", (chunk) => {
    if (finished) {
      return;
    }
    outputBytes += chunk.byteLength;
    if (outputBytes > limitBytes) {
      signalCommand("SIGKILL");
      finish(
        timedOut
          ? { status: "timed_out", ...commandOutput() }
          : { status: "output_limit_exceeded", limitBytes },
      );
      return;
    }
    chunks[index].push(chunk);
  });
  stream.once("end", () => {
    endedStreams += 1;
    completeCommand();
  });
  stream.once("error", fail);
}
child.once("error", (error) => {
  if (error.code === "ENOENT" || error.code === "EACCES") {
    finish({
      status: "exited",
      exitCode: error.code === "ENOENT" ? 127 : 126,
      stdout: "",
      stderr: error.message,
    });
    return;
  }
  fail(error);
});
child.once("exit", (code, signal) => {
  exitCode = code === null ? 128 + constants.signals[signal] : code;
  completeCommand();
});
process.once("SIGTERM", expireCommand);
checkDeadline();
`;

/** One exec invocation supervises the command, its descendants' output, and its byte budget. */
export function createSandboxCommandInvocation(request: SandboxExecRequest): string[] {
  return [
    "node",
    "-e",
    COMMAND_SUPERVISOR_SOURCE,
    JSON.stringify({
      ...request,
      limitBytes: MAX_COMMAND_OUTPUT_BYTES,
      killGraceMs: COMMAND_KILL_GRACE_MS,
    }),
  ];
}
