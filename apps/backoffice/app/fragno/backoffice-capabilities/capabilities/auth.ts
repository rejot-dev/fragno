import { AUTH_SINGLETON_ID } from "@/cloudflare/cloudflare-utils";
import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createAuthCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/auth-files";

export const authCapability: BackofficeCapability = {
  id: "auth",
  label: "Auth",
  kind: "system",
  runtimeToolNamespaces: [],
  get files() {
    return createAuthCapabilityFiles();
  },
  hooks: [
    {
      id: "auth",
      label: "Auth",
      getRepository: ({ env }) =>
        env.AUTH.get(env.AUTH.idFromName(AUTH_SINGLETON_ID)).getDurableHookRepository(),
    },
  ],
};
