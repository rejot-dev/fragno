import { WorkerEntrypoint } from "cloudflare:workers";

import { handleCodemodeCompilerHttpRequest } from "../http/codemode-compiler-http-routes";
import {
  compileCodemodeWorkerRequest,
  typeCheckCodemodeFilesRequest,
} from "./codemode-compiler-operations";

/** Named service-binding RPC entrypoint sharing compiler operations with the public HTTP routes. */
export class CodemodeCompiler extends WorkerEntrypoint<Env> {
  async compileWorker(request: Request): Promise<Response> {
    return await compileCodemodeWorkerRequest(request, this.ctx);
  }

  async typeCheckFiles(request: Request): Promise<Response> {
    return await typeCheckCodemodeFilesRequest(request, this.ctx);
  }

  override async fetch(request: Request): Promise<Response> {
    return (
      (await handleCodemodeCompilerHttpRequest(request, this.env.SANDBOX_API_KEY, this.ctx)) ??
      new Response("Not Found", { status: 404 })
    );
  }
}
