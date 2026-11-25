// Serves Backoffice from a scenario: its setup ran, and /__scenario shows its steps beside the app,
// runs them one at a time, and lets them drive the app's page. The scenario's fakes stand in for
// outside services.
//
//   pnpm --filter @fragno-apps/backoffice-rr scenario-server scripts/scenario-server/scenarios/ada-labs.ts
//
// The scenario module's default export takes a `ScenarioModuleInput` and returns the scenario.
import path from "node:path";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";
import { createServer } from "vite";

import type { BackofficeScenarioDefinition } from "../../app/fragno/automation/scenario";
import type { ScenarioModuleInput, serveScenario } from "./scenario-server";

const backofficeRoot = path.resolve(import.meta.dirname, "../..");
const scenarioPath = process.argv[2];
if (!scenarioPath) {
  throw new Error("Usage: scenario-server <scenario module>");
}

// Beside the worktree's Backoffice ports: the dev server's, its inspector's, and the replay's. The
// dev server is at 127.0.0.1, and browsers keep cookies by host whatever the port, so the scenario's
// sessions are kept at localhost, apart from the dev server's.
const origin = new URL(`http://localhost:${backofficeDevServerPort(backofficeRoot) + 30_000}`);

const vite = await createServer({
  configFile: path.join(backofficeRoot, "vite.node.config.ts"),
  root: backofficeRoot,
  server: { middlewareMode: true, hmr: false, ws: false },
  // Node would load the adapter's React Router apart from the app's, which Vite loads under the
  // `development` condition, and React Router checks the request context is its own class.
  ssr: { noExternal: ["@react-router/express"] },
  appType: "custom",
});

const scenarioModule = (await vite.ssrLoadModule(path.resolve(scenarioPath))) as {
  default: (input: ScenarioModuleInput) => BackofficeScenarioDefinition;
};
const serverModule = (await vite.ssrLoadModule(
  path.join(import.meta.dirname, "scenario-server.ts"),
)) as { serveScenario: typeof serveScenario };

const server = await serverModule.serveScenario({
  vite,
  scenario: scenarioModule.default,
  origin,
});
console.info(`Scenario served at ${origin.origin}/__scenario`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server
      .close()
      .then(() => vite.close())
      .finally(() => process.exit(0));
  });
}
