import { adminClient, customSessionClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { CustomAuth } from "@/lib/auth/auth";

const client = createAuthClient({
  baseURL: process.env["BETTER_AUTH_URL"] || "http://localhost:3000",
  plugins: [customSessionClient<CustomAuth>(), adminClient({})],
});

export const { signIn, signUp, signOut, useSession } = client;
