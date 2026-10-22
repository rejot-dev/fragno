import { posix } from "node:path";

import type { WorkerCompiler } from "@fragno-dev/codemode/compiler/compile-worker";
import { createWorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import { build } from "esbuild";

/**
 * Bundles a source graph into one module for the in-process scenario loader, never production
 * execution. Like the production compiler, absolute specifiers resolve against the project root.
 */
export const compileNodeWorker: WorkerCompiler = async (input) => {
  if (Object.keys(input.dependencies).length > 0) {
    throw new Error("Node codemode compilation does not support npm dependencies.");
  }

  const compiled = await build({
    entryPoints: [input.entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "codemode-source-files",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path.startsWith("cloudflare:") || args.path.startsWith("node:")) {
              return { path: args.path, external: true };
            }
            const path = posix.normalize(
              args.path.startsWith(".")
                ? posix.join(posix.dirname(args.importer), args.path)
                : args.path.replace(/^\//u, ""),
            );
            return Object.hasOwn(input.files, path)
              ? { path, namespace: "codemode" }
              : { errors: [{ text: `Module '${args.path}' is not part of the program.` }] };
          });
          build.onLoad({ filter: /.*/, namespace: "codemode" }, ({ path }) => ({
            contents: input.files[path],
            loader: "js",
          }));
        },
      },
    ],
  });

  return {
    bundle: createWorkerBundle({
      mainModule: input.entryPoint,
      modules: { [input.entryPoint]: compiled.outputFiles[0]?.text ?? "" },
      runtime: input.runtime,
    }),
    warnings: [],
  };
};
