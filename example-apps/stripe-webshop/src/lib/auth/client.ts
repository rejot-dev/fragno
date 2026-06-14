import { customSessionClient } from "better-auth/client/plugins";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { CustomAuth } from "@/lib/auth/auth";

const authClientOptions = {
  baseURL: process.env["BETTER_AUTH_URL"] || "http://localhost:3000",
  plugins: [customSessionClient<CustomAuth>(), adminClient({})],
};

type StripeAuthClient = ReturnType<typeof createAuthClient<typeof authClientOptions>>;

export const authClient: StripeAuthClient = createAuthClient(authClientOptions);

export const signIn: StripeAuthClient["signIn"] = authClient.signIn;
export const signUp: StripeAuthClient["signUp"] = authClient.signUp;
export const signOut: StripeAuthClient["signOut"] = authClient.signOut;
export const useSession: StripeAuthClient["useSession"] = authClient.useSession;
