import { buildWorkerProject } from "@fragno-apps/cf-sandbox-bridge/compiler/build-worker-project";
import { typeCheckProject } from "@fragno-apps/cf-sandbox-bridge/compiler/type-check-project";
import type { TypeCheckFilesInput } from "@fragno-dev/codemode/compiler/compile-worker";
import { env } from "cloudflare:workers";

async function typeCheckFiles(input: TypeCheckFilesInput) {
  const files = await Promise.all(
    input.files.map(async (file) => [file.path, await file.read()] as const),
  );

  async function* readTypeCheckFiles() {
    yield* files;
  }

  return await typeCheckProject({
    files: readTypeCheckFiles(),
    sourcePaths: input.sourcePaths,
  });
}

// Backoffice scenarios use the real compiler directly; the bridge's tests cover private RPC wiring.
Object.assign(env, {
  compileWorker: buildWorkerProject,
  typeCheckFiles,
});
