import { type AuthMeData, createAuthFragmentClient } from "@fragno-dev/auth/react";

export type AuthClient = ReturnType<typeof createAuthFragmentClient>;

export const authClient: AuthClient = createAuthFragmentClient({
  auth: {
    accessTokens: {
      enabled: true,
      transport: "cookie",
    },
    sessionCache: {
      enabled: true,
    },
  },
});

export type { AuthMeData };
