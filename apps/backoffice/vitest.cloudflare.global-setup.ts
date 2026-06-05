import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const backofficeRoot = fileURLToPath(new URL(".", import.meta.url));
const workerBundlerPackageRoot = realpathSync(
  path.resolve(backofficeRoot, "node_modules", "@cloudflare", "worker-bundler"),
);
const wasmSrc = require.resolve("esbuild-wasm/esbuild.wasm");
const wasmDest = path.join(workerBundlerPackageRoot, "dist", "esbuild.wasm");
const viteFsRoot = path.join(backofficeRoot, "@fs");
const viteFsWasmDest = path.join(viteFsRoot, wasmDest.replace(/^\//, ""));
let copiedWasm = false;
let copiedViteFsWasm = false;

const copyIfMissing = (target: string) => {
  if (existsSync(target)) {
    return false;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(wasmSrc, target);
  return true;
};

export function setup() {
  copiedWasm = copyIfMissing(wasmDest);
  copiedViteFsWasm = copyIfMissing(viteFsWasmDest);
}

export function teardown() {
  if (copiedWasm && existsSync(wasmDest)) {
    unlinkSync(wasmDest);
  }
  if (copiedViteFsWasm && existsSync(viteFsWasmDest)) {
    unlinkSync(viteFsWasmDest);
    rmSync(viteFsRoot, { recursive: true, force: true });
  }
}
