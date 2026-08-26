import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKOFFICE_WORKER_TOPOLOGY } from "../backoffice-worker-topology.ts";

const backofficeDirectory = fileURLToPath(new URL("..", import.meta.url));
const backofficeWranglerConfigPath = resolve(backofficeDirectory, "wrangler.jsonc");

type BackofficeWorkerDeploymentOperation = "bootstrap" | "upload" | "deploy";

type BackofficeWorkerDeploymentCommand = {
  operation: BackofficeWorkerDeploymentOperation;
  versionTag: string;
  workerId: string | null;
  dryRun: boolean;
};

type WorkerDeploymentTarget = {
  id: string;
  name: string;
  uploadConfigPath: string;
};

type BackofficeWranglerOperation =
  | "bootstrap deployment"
  | "version upload"
  | "version deployment preflight"
  | "version deployment";

function main() {
  const command = parseBackofficeWorkerDeploymentCommand(process.argv.slice(2));
  const targets = selectWorkerDeploymentTargets(createWorkerDeploymentTargets(), command.workerId);

  if (command.operation === "bootstrap") {
    for (const target of targets) {
      bootstrapWorker(target, command.versionTag, command.dryRun);
    }
    return;
  }

  if (command.operation === "upload") {
    for (const target of targets) {
      uploadWorkerVersion(target, command.versionTag, command.dryRun);
    }
    return;
  }

  for (const target of targets) {
    preflightWorkerVersionDeployment(target, command.versionTag);
  }
  if (command.dryRun) {
    return;
  }
  for (const target of targets) {
    deployWorkerVersion(target, command.versionTag);
  }
}

function parseBackofficeWorkerDeploymentCommand(
  args: readonly string[],
): BackofficeWorkerDeploymentCommand {
  const operation = args[0];
  if (operation !== "bootstrap" && operation !== "upload" && operation !== "deploy") {
    throw new Error(
      "Backoffice Worker deployment argument error: expected 'bootstrap', 'upload', or 'deploy' as the first argument",
    );
  }

  let versionTag = "";
  let workerId: string | null = null;
  let dryRun = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          "Backoffice Worker deployment argument error: '--tag' requires a version tag",
        );
      }
      if (versionTag) {
        throw new Error(
          "Backoffice Worker deployment argument error: '--tag' may only be provided once",
        );
      }
      versionTag = value;
      index += 1;
      continue;
    }
    if (argument === "--worker") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          "Backoffice Worker deployment argument error: '--worker' requires a Worker id",
        );
      }
      if (workerId) {
        throw new Error(
          "Backoffice Worker deployment argument error: '--worker' may only be provided once",
        );
      }
      workerId = value;
      index += 1;
      continue;
    }
    throw new Error(`Backoffice Worker deployment argument error: unknown argument '${argument}'`);
  }

  if (!versionTag) {
    throw new Error(
      "Backoffice Worker deployment argument error: provide the release version with '--tag <version-tag>'",
    );
  }

  return { operation, versionTag, workerId, dryRun };
}

function createWorkerDeploymentTargets(): WorkerDeploymentTarget[] {
  const routeWorkers = Object.entries(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers).map(
    ([workerId, worker]) => ({
      id: workerId,
      name: worker.name,
      uploadConfigPath: resolve(backofficeDirectory, `dist/routes_${workerId}/wrangler.json`),
    }),
  );
  const entryWorker = BACKOFFICE_WORKER_TOPOLOGY.entryWorker;

  return [
    ...routeWorkers,
    {
      id: "entry",
      name: entryWorker.name,
      uploadConfigPath: resolve(backofficeDirectory, "dist/ssr/wrangler.json"),
    },
  ];
}

function selectWorkerDeploymentTargets(
  targets: readonly WorkerDeploymentTarget[],
  workerId: string | null,
): readonly WorkerDeploymentTarget[] {
  if (workerId === null) {
    return targets;
  }

  const target = targets.find((candidate) => candidate.id === workerId);
  if (!target) {
    throw new Error(
      `Backoffice Worker deployment argument error: unknown Worker id '${workerId}'; expected one of ${targets.map((candidate) => candidate.id).join(", ")}`,
    );
  }

  return [target];
}

function bootstrapWorker(target: WorkerDeploymentTarget, versionTag: string, dryRun: boolean) {
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    target.uploadConfigPath,
    "--tag",
    versionTag,
  ];
  if (dryRun) {
    args.push("--dry-run");
  }

  console.log(`Bootstrapping ${target.name} with version tag '${versionTag}'`);
  runBackofficeWranglerCommand(target.name, "bootstrap deployment", args);
}

function uploadWorkerVersion(target: WorkerDeploymentTarget, versionTag: string, dryRun: boolean) {
  const args = [
    "exec",
    "wrangler",
    "versions",
    "upload",
    "--config",
    target.uploadConfigPath,
    "--tag",
    versionTag,
  ];
  if (dryRun) {
    args.push("--dry-run");
  }

  console.log(`Uploading ${target.name} with version tag '${versionTag}'`);
  runBackofficeWranglerCommand(target.name, "version upload", args);
}

function preflightWorkerVersionDeployment(target: WorkerDeploymentTarget, versionTag: string) {
  console.log(`Checking version tag '${versionTag}' for ${target.name}`);
  runBackofficeWranglerCommand(target.name, "version deployment preflight", [
    "exec",
    "wrangler",
    "versions",
    "deploy",
    "--config",
    backofficeWranglerConfigPath,
    "--name",
    target.name,
    "--version-tag",
    `${versionTag}@100%`,
    "--yes",
    "--dry-run",
  ]);
}

function deployWorkerVersion(target: WorkerDeploymentTarget, versionTag: string) {
  console.log(`Deploying ${target.name} with version tag '${versionTag}'`);
  runBackofficeWranglerCommand(target.name, "version deployment", [
    "exec",
    "wrangler",
    "versions",
    "deploy",
    "--config",
    backofficeWranglerConfigPath,
    "--name",
    target.name,
    "--version-tag",
    `${versionTag}@100%`,
    "--yes",
  ]);
}

function runBackofficeWranglerCommand(
  workerName: string,
  operation: BackofficeWranglerOperation,
  args: readonly string[],
) {
  const result = spawnSync("pnpm", args, {
    cwd: backofficeDirectory,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Backoffice Worker ${operation} failed for '${workerName}'`);
  }
}

main();
