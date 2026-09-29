import { bridge } from "@cloudflare/sandbox/bridge";
import { handleCodemodeWorkerRequest } from "@fragno-dev/codemode/worker/codemode-worker-session";

// Wrangler discovers named RPC entrypoints and the existing container/pool classes here.
export { CodemodeCompiler } from "./compiler/codemode-compiler";
export { Sandbox } from "@cloudflare/sandbox";
export { WarmPool } from "@cloudflare/sandbox/bridge";

const sandboxBridge = bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("OK");
  },
}) as unknown as Required<Pick<ExportedHandler<Env>, "fetch" | "scheduled">>;

export default {
  ...sandboxBridge,
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // The SDK claims all /v1/* paths, including unknown ones. Intercept codemode before it,
    // not in bridge({ fetch }), which only receives paths outside the SDK's API prefix.
    if (new URL(request.url).pathname === "/v1/codemode/execute") {
      return await handleCodemodeWorkerRequest(
        request,
        env.SANDBOX_API_KEY,
        {
          loader: env.LOADER,
          async compile(input) {
            // Sandbox-only requests should not initialize the compiler runtime.
            const { buildWorkerProject } = await import("./compiler/build-worker-project");
            return await buildWorkerProject(input);
          },
        },
        ctx,
      );
    }
    return await sandboxBridge.fetch(request, env, ctx);
  },
};
