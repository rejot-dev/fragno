import { createContext, type RouterContext } from "react-router";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

type BackofficeWorkerContextValue = {
  runtime: BackofficeRuntimeServices;
  env: CloudflareEnv;
  ctx: ExecutionContext;
};

const backofficeWorkerContextKey = Symbol.for("fragno.backoffice.worker-runtime-context");

/**
 * BackofficeWorkerContext provides access to the Worker environment, execution context, and
 * Backoffice runtime services throughout the React Router app.
 *
 * Keep the context object stable across Vite/React Router module reloads. The worker entry sets
 * this object and route modules read it; if dev SSR evaluates this file twice, React Router sees
 * two different context keys and `context.get()` throws "No value found for context".
 */
export const BackofficeWorkerContext = ((globalThis as Record<symbol, unknown>)[
  backofficeWorkerContextKey
] ??= createContext<BackofficeWorkerContextValue>()) as RouterContext<BackofficeWorkerContextValue>;
