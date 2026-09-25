import path from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "shims/node-cloudflare-workers.ts"),
      "@": path.resolve(__dirname, "app"),
      ajv: path.resolve(__dirname, "shims/ajv.ts"),
      "ajv-formats": path.resolve(__dirname, "shims/ajv-formats.ts"),
      undici: path.resolve(__dirname, "shims/undici.ts"),
    },
  },
  build: {
    ssr: true,
    outDir: "build-node",
    emptyOutDir: false,
    rolldownOptions: {
      input: {
        "node-server": path.resolve(__dirname, "scripts/node-server/node-server.mts"),
        "node-hook-processor": path.resolve(
          __dirname,
          "scripts/node-server/node-hook-processor.mts",
        ),
      },
      output: { entryFileNames: "[name].mjs" },
    },
  },
});
