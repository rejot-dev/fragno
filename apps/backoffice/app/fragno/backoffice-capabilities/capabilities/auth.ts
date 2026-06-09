import { AUTH_SINGLETON_ID } from "@/cloudflare/cloudflare-utils";
import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const authCapability: BackofficeCapability = {
  id: "auth",
  label: "Auth",
  kind: "system",
  runtimeToolNamespaces: [],
  hooks: [
    {
      id: "auth",
      label: "Auth",
      getRepository: ({ env }) =>
        env.AUTH.get(env.AUTH.idFromName(AUTH_SINGLETON_ID)).getDurableHookRepository(),
    },
  ],
};
