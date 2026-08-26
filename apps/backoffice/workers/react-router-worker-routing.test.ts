import { assert, describe, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BACKOFFICE_WORKER_TOPOLOGY } from "../backoffice-worker-topology";
import { getReactRouterWorkerEntries } from "./react-router-worker-routing";

describe("Backoffice Worker topology", () => {
  it("uses unique Worker names and service bindings", () => {
    const workers = getReactRouterWorkerEntries().map(([, worker]) => worker);
    assert.equal(new Set(workers.map((worker) => worker.name)).size, workers.length);
    assert.equal(new Set(workers.map((worker) => worker.serviceBinding)).size, workers.length);
  });

  it("assigns every documented environment name to at least one Worker", () => {
    const devVarsExamplePath = fileURLToPath(new URL("../.dev.vars.example", import.meta.url));
    const documentedNames = readFileSync(devVarsExamplePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")));
    const environments = [
      BACKOFFICE_WORKER_TOPOLOGY.entryWorker.environment,
      ...getReactRouterWorkerEntries().map(([, worker]) => worker.environment),
    ];
    const assignedNames = new Set<string>(
      environments.flatMap((environment) => [
        ...environment.variables,
        ...environment.secrets.required,
        ...environment.secrets.optional,
      ]),
    );

    assert.deepEqual(
      documentedNames.filter((name) => !assignedNames.has(name)),
      [],
    );
  });
});
