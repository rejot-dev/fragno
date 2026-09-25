import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

import tailwindcss from "@tailwindcss/vite";

import { emitWaSqliteWasmAssetPlugin } from "./scripts/node-server/vite-wa-sqlite-wasm-asset";

// Separate from the Cloudflare Vite plugin: the server bundle runs under Node.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom", "react-router"],
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "shims/node-cloudflare-workers.ts"),
      "@/components": path.resolve(__dirname, "app/components"),
      "@/lib": path.resolve(__dirname, "app/lib"),
      ajv: path.resolve(__dirname, "shims/ajv.ts"),
      "ajv-formats": path.resolve(__dirname, "shims/ajv-formats.ts"),
      undici: path.resolve(__dirname, "shims/undici.ts"),
    },
  },
  plugins: [tailwindcss(), reactRouter(), emitWaSqliteWasmAssetPlugin()],
  ssr: {
    noExternal: ["@earendil-works/pi-ai"],
  },
});
