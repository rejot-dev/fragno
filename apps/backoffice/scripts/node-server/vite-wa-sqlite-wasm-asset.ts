import { readFileSync } from "node:fs";

import type { Plugin } from "vite";

/** Publishes the sibling WASM file required by wa-sqlite's OPFS browser worker. */
export function emitWaSqliteWasmAssetPlugin(): Plugin {
  const wasmUrl = new URL(import.meta.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm"));
  return {
    name: "emit-wa-sqlite-wasm-asset",
    apply: "build",
    generateBundle() {
      if (this.environment.name !== "client") {
        return;
      }
      this.emitFile({
        type: "asset",
        fileName: "assets/wa-sqlite.wasm",
        source: readFileSync(wasmUrl),
      });
    },
  };
}
