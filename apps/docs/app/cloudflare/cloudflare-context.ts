import { createContext } from "react-router";

/**
 * CloudflareContext provides access to the Cloudflare environment and execution context
 * throughout the React Router app.
 */
export const CloudflareContext = createContext<{
  env: CloudflareEnv;
  ctx: ExecutionContext;
}>();
