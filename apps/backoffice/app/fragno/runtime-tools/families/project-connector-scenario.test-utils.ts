import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startProjectConnectorTestGateway } from "@fragno-dev/project-connector-fragment/testing";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";

/** Exercises the production scoped host with real SQLite and HTTP, never a real project key. */
export async function runProjectConnectorScenario<TVars extends Record<string, unknown>>(
  defineScenario: (
    gateway: Awaited<ReturnType<typeof startProjectConnectorTestGateway>>,
  ) => BackofficeScenarioDefinitionInput<TVars>,
) {
  const gateway = await startProjectConnectorTestGateway();
  try {
    const directory = await mkdtemp(path.join(tmpdir(), "backoffice-project-connector-"));
    try {
      const scenario = defineScenario(gateway);
      await runBackofficeScenario(
        defineBackofficeScenario({
          ...scenario,
          env: {
            OOMOL_CONNECTOR_BASE_URL: gateway.baseUrl,
            OOMOL_PROJECT_API_KEY: "test-project-key",
            ...scenario.env,
          },
          options: { ...scenario.options, sqliteDataDirectory: directory },
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await gateway.close();
  }
}
