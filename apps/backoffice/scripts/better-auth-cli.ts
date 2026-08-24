import { betterAuth, type BetterAuthOptions } from "better-auth";
import Database from "better-sqlite3";

import { createBackofficeBetterAuthSchemaPlugins } from "../workers/auth/better-auth-schema-plugins";

const options: BetterAuthOptions = {
  appName: "Fragno Backoffice",
  baseURL: "http://localhost",
  basePath: "/api/auth",
  secret: "backoffice-better-auth-schema-generation-secret",
  database: new Database(":memory:"),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 100,
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: { enabled: true, trustedProviders: ["github"] },
  },
  plugins: createBackofficeBetterAuthSchemaPlugins({
    baseURL: "http://localhost",
    organizationHooks: null,
  }),
};

/** Better Auth CLI configuration used to generate the committed full SQLite schema. */
export const auth = betterAuth(options);
