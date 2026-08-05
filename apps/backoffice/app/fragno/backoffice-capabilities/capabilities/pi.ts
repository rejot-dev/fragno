import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { PiRuntimeState } from "@/fragno/pi/pi-shared";

const capability = { id: "pi", label: "Pi", kind: "connection" } as const;

const toPiStatus = (state: PiRuntimeState): ConnectionStatus => ({
  ...capability,
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

export const piCapability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: ["pi"],
  connection: {
    configurable: false,
    getStatus: async ({ objects, scope }) =>
      toPiStatus(await objects.pi.for(scope).getRuntimeState(scope)),
    verify: async ({ objects, scope }) =>
      toPiStatus(await objects.pi.for(scope).getRuntimeState(scope)),
  },
  hooks: [
    {
      id: "pi",
      label: "Pi",
      getRepository: ({ objects, scope }) =>
        objects.pi.for(scope).getDurableHookRepository(scope, "pi"),
    },
    {
      id: "pi-workflows",
      label: "Pi workflows",
      getRepository: ({ objects, scope }) =>
        objects.pi.for(scope).getDurableHookRepository(scope, "workflows"),
    },
  ],
};
