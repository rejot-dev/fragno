import { env } from "cloudflare:workers";

import type { TypeCheckFilesInput } from "@/backoffice-runtime/dynamic-workers/compile-worker";

import { buildWorkerProject } from "./compiler/build-worker-project";
import { typeCheckProject } from "./compiler/type-check-project";

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

// Workers tests use the production compiler implementation without requiring a separately deployed service.
Object.assign(env, {
  compileWorker: buildWorkerProject,
  typeCheckFiles,
});
