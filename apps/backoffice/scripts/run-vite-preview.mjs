import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
// Backoffice fails sandbox starts at once when told the bridge has no containers.
const backofficeWorkerConfigUrls = [
  new URL("../build/server/wrangler.json", import.meta.url),
  new URL("../dist/rejot_backoffice/wrangler.json", import.meta.url),
];

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

// Every run sets both sides, so output left patched by a killed run cannot leak into the next one.
const configPatches = [
  {
    url: containerWorkerConfigUrl,
    patch: (config) => ({ ...config, dev: { ...config.dev, enable_containers: enableContainers } }),
  },
  ...backofficeWorkerConfigUrls.map((url) => ({
    url,
    patch: (config) => ({
      ...config,
      vars: { ...config.vars, SANDBOX_CONTAINERS: String(enableContainers) },
    }),
  })),
];

// A build replaces the output the preview serves, but the running Workers keep requesting the old
// asset chunks. vite.config.ts writes this marker once a build has finished, and the preview
// restarts on the new output.
const buildCompleteMarkerPath = fileURLToPath(new URL("../build/.build-complete", import.meta.url));
let restartRequested = false;
watchFile(buildCompleteMarkerPath, { interval: 500 }, (current, previous) => {
  // A starting build deletes the marker; the preview keeps running until the build has finished.
  if (current.mtimeMs === 0 || current.mtimeMs === previous.mtimeMs) {
    return;
  }
  restartRequested = true;
  activeChild?.kill("SIGTERM");
});

// A build that started meanwhile may have removed the output, but any other failure to read it
// must not skip restoring the configs.
async function readConfigIfPresent(url) {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOriginalConfigs() {
  try {
    return await Promise.all(configPatches.map(({ url }) => readFile(url, "utf8")));
  } catch (cause) {
    throw new Error(
      "Backoffice preview output is missing. Run `pnpm --filter @fragno-apps/backoffice-rr build` before previewing.",
      { cause },
    );
  }
}

try {
  do {
    if (restartRequested) {
      console.log("\nBackoffice build finished, restarting preview on the new output.\n");
      restartRequested = false;
    }
    const originalConfigs = await readOriginalConfigs();
    const patchedConfigs = configPatches.map(({ patch }, index) =>
      JSON.stringify(patch(JSON.parse(originalConfigs[index]))),
    );
    try {
      for (const [index, { url }] of configPatches.entries()) {
        await writeFile(url, patchedConfigs[index]);
      }
      process.exitCode = (await runViteCommand(previewCommand)).code;
    } finally {
      // A build that ran meanwhile wrote its own configs, which must not be replaced by older ones.
      for (const [index, { url }] of configPatches.entries()) {
        if ((await readConfigIfPresent(url)) === patchedConfigs[index]) {
          await writeFile(url, originalConfigs[index]);
        }
      }
    }
  } while (restartRequested && !stopSignal);
} finally {
  unwatchFile(buildCompleteMarkerPath);
}
