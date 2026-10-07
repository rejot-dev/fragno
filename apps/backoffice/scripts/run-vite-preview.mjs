import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const enableContainersFlag = "--containers";
const enableSourceMapsFlag = "--sourcemap";
const enableContainers = process.argv.includes(enableContainersFlag);
const enableSourceMaps = process.argv.includes(enableSourceMapsFlag);
const previewArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== enableContainersFlag && argument !== enableSourceMapsFlag);
const previewCommand = ["vite", "preview", "--strictPort=false", ...previewArgs];
const containerWorkerConfigUrl = new URL("../dist/rejot_backoffice/wrangler.json", import.meta.url);

function runViteCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", ...args], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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
