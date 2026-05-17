import { createContext, type RouterContext } from "react-router";

type CloudflareContextValue = {
  env: CloudflareEnv;
  ctx: ExecutionContext;
};

const cloudflareContextKey = Symbol.for("fragno.backoffice.cloudflare-context");

/**
 * CloudflareContext provides access to the Cloudflare environment and execution context
 * throughout the React Router app.
 *
 * Keep the context object stable across Vite/React Router module reloads. The worker entry sets
 * this object and route modules read it; if dev SSR evaluates this file twice, React Router sees
 * two different context keys and `context.get()` throws "No value found for context".
 */
export const CloudflareContext = ((globalThis as Record<symbol, unknown>)[cloudflareContextKey] ??=
  createContext<CloudflareContextValue>()) as RouterContext<CloudflareContextValue>;
