import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { BACKOFFICE_WORKER_TOPOLOGY } from "../backoffice-worker-topology.ts";

const backofficeDirectory = fileURLToPath(new URL("..", import.meta.url));
const backofficeWranglerConfigPath = resolve(backofficeDirectory, "wrangler.jsonc");

type WranglerWorkerVersion = {
  id: string;
  number: number;
  metadata: {
    created_on: string;
  };
  annotations: Record<string, string>;
};

type WranglerWorkerDeployment = {
  created_on: string;
  versions: Array<{
    version_id: string;
    percentage: number;
  }>;
};

type WranglerCommandResult =
  | { kind: "success"; value: unknown }
  | { kind: "failure"; message: string };

type BackofficeWorkerStatus = {
  name: string;
  versions: WranglerCommandResult;
  deployment: WranglerCommandResult;
};

async function main() {
  const workerNames = [
    ...Object.values(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers).map((worker) => worker.name),
    BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name,
  ];
  const statuses: BackofficeWorkerStatus[] = [];
  for (const workerName of workerNames) {
    statuses.push(await loadBackofficeWorkerStatus(workerName));
  }

  for (const [index, status] of statuses.entries()) {
    if (index > 0) {
      console.log();
    }
    printBackofficeWorkerStatus(status);
  }

  if (statuses.some(hasBackofficeWorkerStatusFailure)) {
    process.exitCode = 1;
  }
}

async function loadBackofficeWorkerStatus(name: string): Promise<BackofficeWorkerStatus> {
  const [versions, deployment] = await Promise.all([
    runWranglerJsonCommand([
      "exec",
      "wrangler",
      "versions",
      "list",
      "--config",
      backofficeWranglerConfigPath,
      "--name",
      name,
      "--json",
    ]),
    runWranglerJsonCommand([
      "exec",
      "wrangler",
      "deployments",
      "status",
      "--config",
      backofficeWranglerConfigPath,
      "--name",
      name,
      "--json",
    ]),
  ]);

  return { name, versions, deployment };
}

function printBackofficeWorkerStatus(status: BackofficeWorkerStatus) {
  console.log(status.name);

  if (status.versions.kind === "failure") {
    console.log(`  Uploads: unavailable (${status.versions.message})`);
  }
  if (status.deployment.kind === "failure") {
    console.log(`  Deployed: unavailable (${status.deployment.message})`);
  }
  if (status.versions.kind === "failure" || status.deployment.kind === "failure") {
    return;
  }

  const versions = status.versions.value as WranglerWorkerVersion[];
  const deployment = status.deployment.value as WranglerWorkerDeployment;
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const deployedPercentages = new Map(
    deployment.versions.map((version) => [version.version_id, version.percentage]),
  );

  if (deployment.versions.length === 0) {
    console.log("  Deployed: none");
  } else {
    console.log(`  Deployed: ${deployment.created_on}`);
    for (const deployedVersion of deployment.versions) {
      const version = versionsById.get(deployedVersion.version_id);
      console.log(
        `    ${formatWorkerVersionIdentity(version, deployedVersion.version_id)} @ ${deployedVersion.percentage}%`,
      );
    }
  }

  if (versions.length === 0) {
    console.log("  Uploads: none");
    return;
  }

  console.log("  Uploads:");
  for (const version of [...versions].reverse()) {
    const deployedPercentage = deployedPercentages.get(version.id);
    const deploymentMarker =
      deployedPercentage === undefined ? "uploaded" : `deployed ${deployedPercentage}%`;
    console.log(
      `    #${version.number} ${formatWorkerVersionTag(version)} ${version.id} ${version.metadata.created_on} [${deploymentMarker}]`,
    );
  }
}

function formatWorkerVersionIdentity(
  version: WranglerWorkerVersion | undefined,
  versionId: string,
) {
  return version
    ? `#${version.number} ${formatWorkerVersionTag(version)} ${version.id}`
    : versionId;
}

function formatWorkerVersionTag(version: WranglerWorkerVersion) {
  return version.annotations["workers/tag"] ?? "(untagged)";
}

function hasBackofficeWorkerStatusFailure(status: BackofficeWorkerStatus) {
  return status.versions.kind === "failure" || status.deployment.kind === "failure";
}

function runWranglerJsonCommand(args: readonly string[]): Promise<WranglerCommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn("pnpm", args, {
      cwd: backofficeDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveCommand({ kind: "failure", message: error.message });
    });
    child.on("close", (status) => {
      if (status !== 0) {
        resolveCommand({
          kind: "failure",
          message: findWranglerErrorMessage(stderr) ?? `Wrangler exited with status ${status}`,
        });
        return;
      }

      try {
        resolveCommand({ kind: "success", value: JSON.parse(stdout) as unknown });
      } catch {
        resolveCommand({ kind: "failure", message: "Wrangler returned invalid JSON" });
      }
    });
  });
}

function findWranglerErrorMessage(stderr: string) {
  const lines = stripVTControlCharacters(stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.find((line) => line.includes("[code:")) ?? lines.find((line) => !line.startsWith("🪵"))
  );
}

await main();
