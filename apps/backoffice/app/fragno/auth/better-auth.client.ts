import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const client = createAuthClient({
  plugins: [organizationClient(), adminClient()],
});

/** Exposes SDK commands directly, without a second application session store. */
export const betterAuthClient = {
  signIn: client.signIn,
  organization: client.organization,
  admin: client.admin,
};
