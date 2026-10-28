import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const enableContainersFlag = "--containers";
const enableSourceMapsFlag = "--sourcemap";
const enableContainers = process.argv.includes(enableContainersFlag);
const enableSourceMaps = process.argv.includes(enableSourceMapsFlag);
const previewArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== enableContainersFlag && argument !== enableSourceMapsFlag);
const previewCommand = ["vite", "preview", ...previewArgs];
// The bridge Worker hosts the Sandbox containers that the object Worker binds to.
const containerWorkerConfigUrl = new URL(
  "../dist/cf_sandbox_bridge/wrangler.json",
  import.meta.url,
);

let activeChild = null;
let stopSignal = null;

// Ctrl-C signals the whole process group. Without handlers Node exits at once and skips the
// configuration restore below, so the wrapper stays up until Vite has shut down.
function stopViteCommand(signal) {
  stopSignal = signal;
  activeChild?.kill(signal);
}
process.on("SIGINT", stopViteCommand);
process.on("SIGTERM", stopViteCommand);

function runViteCommand(args) {
  if (stopSignal) {
    return Promise.resolve({ code: 0, signal: stopSignal });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", ...args], {
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = null;
      if (signal && signal !== "SIGINT" && signal !== "SIGTERM") {
        reject(new Error(`Backoffice Vite command terminated by ${signal}`));
        return;
      }
      resolve({ code: code ?? (signal ? 0 : 1), signal });
    });
  });
}

if (enableSourceMaps) {
  // Preview serves existing output, so source maps must be generated before it starts.
  const buildResult = await runViteCommand([
    "react-router",
    "build",
    "--sourcemapClient",
    "--sourcemapServer",
  ]);
  if (buildResult.code !== 0 || buildResult.signal) {
    process.exit(buildResult.code);
  }
}

if (!enableContainers) {
  process.exit((await runViteCommand(previewCommand)).code);
}

let originalConfig;
try {
  originalConfig = await readFile(containerWorkerConfigUrl, "utf8");
} catch (cause) {
  throw new Error(
    "Backoffice preview output is missing. Run `pnpm --filter @fragno-apps/backoffice-rr build` before previewing with containers.",
    { cause },
  );
}

const config = JSON.parse(originalConfig);
config.dev = { ...config.dev, enable_containers: true };
await writeFile(containerWorkerConfigUrl, JSON.stringify(config));

try {
  process.exitCode = (await runViteCommand(previewCommand)).code;
} finally {
  await writeFile(containerWorkerConfigUrl, originalConfig);
}
