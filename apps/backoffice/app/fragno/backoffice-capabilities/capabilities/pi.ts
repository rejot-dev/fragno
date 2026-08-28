import type { AutomationsObject } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";
import type { DurableHookRepository } from "@/fragno/durable-hooks";
import type { PiRuntimeState } from "@/fragno/pi/pi-shared";

const connectionStatusIdentity = {
  id: "pi",
  label: "Pi",
  kind: "connection",
} as const;

const toPiStatus = (state: PiRuntimeState): ConnectionStatus => ({
  ...connectionStatusIdentity,
  configured: state.configured,
  config: { modelCatalog: state.modelCatalog },
  verification: state.configured
    ? { ok: true, message: "Pi has at least one authenticated model provider." }
    : { ok: false, message: "Pi has no authenticated model provider." },
  ...(!state.configured
    ? {
        missing: ["providerCredentials"],
        nextSteps: [
          "Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in the Worker environment.",
        ],
      }
    : {}),
});

function createPiDurableHookRepository(commands: AutomationsObject): DurableHookRepository {
  return createDurableHookRepositoryFromCommands({
    getDurableHookQueue: async (options) => await commands.getDurableHookQueue("pi", options),
    getDurableHook: async (hookId) => await commands.getDurableHook("pi", hookId),
  });
}

export const piCapability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: "AUTOMATIONS",
  contributions: {
    connection: {
      configurable: false,
      getStatus: async ({ objects, scope }) =>
        toPiStatus(await objects.automations.for(scope).commands.getPiRuntimeState()),
      verify: async ({ objects, scope }) =>
        toPiStatus(await objects.automations.for(scope).commands.getPiRuntimeState()),
    },
    eventSources: [],
    actionProviders: ["pi"],
    hookScopes: [
      {
        id: "pi",
        label: "Pi",
        getRepository: ({ objects, scope }) =>
          createPiDurableHookRepository(objects.automations.for(scope).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [],
  },
};
