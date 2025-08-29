// https://nuxt.com/docs/api/configuration/nuxt-config

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Gets all local ts project references and makes it so they are included in the nuxt tsconfigs.
const tsConfig = JSON.parse(readFileSync(join(process.cwd(), "tsconfig.json"), "utf-8"));
const references = (tsConfig.references as { path: string }[])
  .filter((ref) => !ref.path.includes(".nuxt"))
  .map((ref) => ({
    path: `../${ref.path}`,
  }));

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  nitro: {
    typescript: {
      tsConfig: {
        references,
      },
    },
  },
  typescript: {
    tsConfig: {
      references,
    },
  },
  vite: {
    optimizeDeps: {
      include: ["zod"],
    },
    ssr: {
      noExternal: ["zod"],
    },
  },
});
