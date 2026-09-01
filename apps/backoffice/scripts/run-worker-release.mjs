import { spawnSync } from "node:child_process";

const releaseOperation = process.argv[2];
const releaseArguments = process.argv.slice(3);
const forwardedArguments =
  releaseArguments[0] === "--" ? releaseArguments.slice(1) : releaseArguments;
const wranglerExecutable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const workerVersionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@\d+(?:\.\d+)?%?)?$/i;
const workerCommands = {
  bootstrap: [
    ["deploy", "--config", "build/server/wrangler.json"],
    ["deploy", "--config", "dist/rejot_backoffice/wrangler.json", "--containers-rollout=none"],
  ],
  upload: [
    ["versions", "upload", "--config", "build/server/wrangler.json"],
    ["versions", "upload", "--config", "dist/rejot_backoffice/wrangler.json"],
  ],
  deploy: [
    ["versions", "deploy", "--config", "wrangler.web.jsonc"],
    ["versions", "deploy", "--config", "wrangler.jsonc"],
  ],
};

if (!Object.hasOwn(workerCommands, releaseOperation)) {
  throw new Error("Usage: node scripts/run-worker-release.mjs <bootstrap|upload|deploy> [args...]");
}

if (releaseOperation === "deploy") {
  validateSharedWorkerVersionTag(forwardedArguments);
}

for (const commandArguments of workerCommands[releaseOperation]) {
  const result = spawnSync(wranglerExecutable, [...commandArguments, ...forwardedArguments], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function validateSharedWorkerVersionTag(argumentsToValidate) {
  const hasWorkerVersionId = argumentsToValidate.some(
    (argument) =>
      argument === "--version-id" ||
      argument.startsWith("--version-id=") ||
      argument === "--percentage" ||
      argument.startsWith("--percentage=") ||
      workerVersionIdPattern.test(argument),
  );
  if (hasWorkerVersionId) {
    throw new Error(
      "Backoffice release deploy does not accept Worker-specific version IDs; use --version-tag.",
    );
  }

  const hasSharedVersionTag = argumentsToValidate.some(
    (argument, index) =>
      (argument === "--version-tag" &&
        Boolean(argumentsToValidate[index + 1]) &&
        !argumentsToValidate[index + 1].startsWith("-")) ||
      (argument.startsWith("--version-tag=") && argument.length > "--version-tag=".length),
  );
  if (!hasSharedVersionTag) {
    throw new Error(
      "Backoffice release deploy requires --version-tag so each Worker resolves its own version.",
    );
  }
}
