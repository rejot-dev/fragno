import { reactRouter } from "@react-router/dev/vite";
import { envOnlyMacros } from "vite-env-only";
import devtoolsJson from "vite-plugin-devtools-json";
import { defineConfig } from "vite-plus";
import type { PluginOption } from "vite-plus";
import { coverageConfigDefaults } from "vite-plus";

import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    envOnlyMacros() as any,
    tailwindcss(),
    reactRouter(),
  ];
  if (mode !== "production") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.push(devtoolsJson() as any);
  }
  return {
    resolve: {
      tsconfigPaths: true,
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
      environment: "node",
      watch: false,
    },
  };
});
