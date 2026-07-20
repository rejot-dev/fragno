import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";
import { envOnlyMacros } from "vite-env-only";
import devtoolsJson from "vite-plugin-devtools-json";

import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [envOnlyMacros() as PluginOption, tailwindcss(), reactRouter()];
  if (mode !== "production") {
    plugins.push(devtoolsJson() as PluginOption);
  }
  return {
    resolve: {
      tsconfigPaths: true,
    },
    plugins,
  };
});
