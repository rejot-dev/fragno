import waSqliteWasm from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm";

/**
 * wa-sqlite's synchronous build, which the Worker's bundler compiles as a module of the Worker.
 * Workers cannot compile WebAssembly at runtime. Node builds and tests alias this module to
 * `shims/node-wa-sqlite-wasm.ts`.
 */
export function loadWaSqliteWasm(): Promise<WebAssembly.Module> {
  return Promise.resolve(waSqliteWasm);
}
