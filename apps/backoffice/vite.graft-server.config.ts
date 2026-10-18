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
  ssr: {
    external: ["better-sqlite3", "@fragno-private/backoffice-node-runtime", "@hono/node-server"],
    noExternal: true,
  },
  build: {
    ssr: true,
    outDir: "build-graft",
    emptyOutDir: false,
    rolldownOptions: {
      input: {
        "backoffice-node": path.resolve(__dirname, "scripts/graft-server/backoffice-node.mts"),
        "node-graft-native-smoke": path.resolve(
          __dirname,
          "scripts/graft-server/node-graft-native-smoke.mts",
        ),
        "graft-backoffice-objects": path.resolve(
          __dirname,
          "app/backoffice-runtime/node/graft-backoffice.objects.ts",
        ),
        "node-opentelemetry-bootstrap": path.resolve(
          __dirname,
          "scripts/node-server/node-opentelemetry-bootstrap.mts",
        ),
      },
      output: { entryFileNames: "[name].mjs" },
    },
  },
});
