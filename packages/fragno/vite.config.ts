import { svelteTesting } from "@testing-library/svelte/vite";
import { coverageConfigDefaults, defineConfig } from "vite-plus";
import type { PluginOption } from "vite-plus";

import { svelte } from "@sveltejs/vite-plugin-svelte";

const plugins: PluginOption[] = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svelte() as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svelteTesting() as any,
];

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: [
      "./src/mod.ts",
      "./src/mod-client.ts",
      "./src/api/api.ts",
      "./src/api/shared-types.ts",
      "./src/api/fragment-definition-builder.ts",
      "./src/api/fragment-instantiator.ts",
      "./src/api/route.ts",
      "./src/api/request-context-storage.ts",
      "./src/request/request.ts",
      "./src/client/client.ts",
      "./src/id.ts",
      "./src/client/vanilla.ts",
      "./src/client/client.svelte.ts",
      "./src/client/react.ts",
      "./src/client/vue.ts",
      "./src/client/solid.ts",
      "./src/integrations/react-ssr.ts",
      "./src/test/test.ts",
      "./src/internal/trace-context.ts",
      "./src/internal/symbols.ts",
    ],
    dts: true,
    unbundle: true,
  },

  plugins,

  test: {
    globals: true,
    coverage: {
      provider: "istanbul",
      exclude: ["templates/**", ...coverageConfigDefaults.exclude],
      reporter: [["json", { file: "../coverage.json" }]],
      enabled: true,
    },
    environment: "happy-dom",
  },
});
