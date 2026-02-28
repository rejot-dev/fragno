import { createAuthFragmentClient } from "@fragno-dev/auth/react";

export const authClient = createAuthFragmentClient();

export type AuthMeData = Awaited<ReturnType<typeof authClient.me>>;
