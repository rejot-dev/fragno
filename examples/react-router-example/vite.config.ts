import { defineConfig } from "vite";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig(({ mode }) => {
  const plugins = [tailwindcss(), reactRouter(), tsconfigPaths()];
  if (mode !== "production") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.push(devtoolsJson() as any);
  }
  return {
    plugins,
  };
});
