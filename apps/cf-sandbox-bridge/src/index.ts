import { Hono } from "hono";

import { registerCodemodeCompilerHttpRoutes } from "./http/codemode-compiler-http-routes";
import { registerCodemodeExecutionHttpRoute } from "./http/codemode-execution-http-route";
import type { SandboxBridgeHonoEnv } from "./http/sandbox-bridge-http-env";
import { registerSandboxHttpRoutes } from "./http/sandbox-http-routes";

// Wrangler discovers named RPC entrypoints and Durable Object classes here.
export { CodemodeCompiler } from "./compiler/codemode-compiler-entrypoint";
export { CodemodeExecutor } from "./execution/codemode-executor-entrypoint";
export { Sandbox } from "./sandbox/sandbox.do";
export { SandboxBackofficeEgress } from "./sandbox/sandbox-backoffice-egress";

const app = new Hono<SandboxBridgeHonoEnv>();
app.get("/health", (context) => context.json({ ok: true }));
registerCodemodeCompilerHttpRoutes(app);
registerCodemodeExecutionHttpRoute(app);
registerSandboxHttpRoutes(app);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
