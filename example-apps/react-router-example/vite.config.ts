import { defineConfig } from "vite";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import { envOnlyMacros } from "vite-env-only";
import type { PluginOption } from "vite";

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
  };
});
