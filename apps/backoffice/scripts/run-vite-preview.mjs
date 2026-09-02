import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const enableContainersFlag = "--containers";
const enableContainers = process.argv.includes(enableContainersFlag);
const previewArgs = process.argv.slice(2).filter((argument) => argument !== enableContainersFlag);
const containerWorkerConfigUrl = new URL("../dist/rejot_backoffice/wrangler.json", import.meta.url);

function runPreview() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vite", "preview", ...previewArgs], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal && signal !== "SIGINT" && signal !== "SIGTERM") {
        reject(new Error(`vite preview terminated by ${signal}`));
        return;
      }
      resolve(code ?? (signal ? 0 : 1));
    });
  });
}

if (!enableContainers) {
  process.exit(await runPreview());
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
  process.exitCode = await runPreview();
} finally {
  await writeFile(containerWorkerConfigUrl, originalConfig);
}
