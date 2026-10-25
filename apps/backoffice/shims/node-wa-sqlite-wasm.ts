import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

let compiled: Promise<WebAssembly.Module> | undefined;

/** wa-sqlite's synchronous build, compiled from the installed package. */
export function loadWaSqliteWasm(): Promise<WebAssembly.Module> {
  compiled ??= readFile(
    createRequire(import.meta.url).resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm"),
  ).then((bytes) => WebAssembly.compile(bytes));
  return compiled;
}
