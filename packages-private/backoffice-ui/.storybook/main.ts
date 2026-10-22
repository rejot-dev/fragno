import { fileURLToPath } from "node:url";

import { mergeConfig } from "vite";

import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          // Page stories build the example pages Backoffice serves under /static, so edits to
          // them show up here. Only Storybook reads them; the package imports nothing from the app.
          "@backoffice-static": fileURLToPath(
            new URL("../../../apps/backoffice/content/static", import.meta.url),
          ),
        },
      },
    }),
};

export default config;
