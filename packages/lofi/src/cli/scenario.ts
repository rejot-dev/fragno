import { define } from "gunshi";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runScenario, type ScenarioDefinition } from "../scenario.js";
import { installIndexedDbGlobals } from "./utils.js";

type ScenarioModule = {
  default?: ScenarioDefinition | (() => ScenarioDefinition | Promise<ScenarioDefinition>);
  scenario?: ScenarioDefinition | (() => ScenarioDefinition | Promise<ScenarioDefinition>);
};

const resolveScenarioModule = async (modulePath: string): Promise<ScenarioDefinition> => {
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const mod = (await import(url)) as ScenarioModule;
  const candidate = mod.default ?? mod.scenario;

  if (!candidate) {
    throw new Error("Scenario module must export a default scenario.");
  }

  if (typeof candidate === "function") {
    return await candidate();
  }

  return candidate;
};

export const scenarioCommand = define({
  name: "scenario",
  description: "Run a multi-client Lofi scenario",
  args: {
    file: {
      type: "string" as const,
      short: "f" as const,
      description: "Path to a scenario module",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const file = ctx.values["file"] as string;
    installIndexedDbGlobals();

    const scenario = await resolveScenarioModule(file);
    const context = await runScenario(scenario);

    try {
      const output = {
        name: context.name,
        baseUrl: context.server.baseUrl,
        vars: context.vars,
        lastSubmit: context.lastSubmit,
        lastSync: context.lastSync,
      };
      console.log(JSON.stringify(output, null, 2));
    } finally {
      await context.cleanup();
    }
  },
});
