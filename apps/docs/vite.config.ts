import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import mdx from "fumadocs-mdx/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import * as MdxConfig from "./source.config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import path from "path";
import type { Plugin } from "vite";

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        "@/components": path.resolve(__dirname, "./app/components"),
        "@/lib": path.resolve(__dirname, "./app/lib"),
      },
    },
    plugins: [
      mdx(MdxConfig),
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tailwindcss(),
      reactRouter(),
      tsconfigPaths({
        root: __dirname,
      }),
      devtoolsJson(),
    ],
    optimizeDeps: {
      include: ["hast-util-to-jsx-runtime"],
    },
  };
});

// oxlint-disable-next-line no-unused-vars
function environmentInfoPlugin(): Plugin {
  return {
    name: "environment-info",
    configResolved(config) {
      const envInfo: Record<string, unknown> = {
        root: config.root,
        mode: config.mode,
        command: config.command,
        environments: {},
      };

      // Collect environment information
      for (const [name, env] of Object.entries(config.environments)) {
        (envInfo.environments as Record<string, unknown>)[name] = {
          resolve: {
            conditions: env.resolve.conditions,
            externalConditions: env.resolve.externalConditions,
            mainFields: env.resolve.mainFields,
          },
          build: {
            outDir: env.build.outDir,
            sourcemap: env.build.sourcemap,
            minify: env.build.minify,
            target: env.build.target,
          },
          consumer: env.consumer,
        };
      }

      const outputPath = join(config.root, "vite-environments.json");
      writeFileSync(outputPath, JSON.stringify(envInfo, null, 2), "utf-8");
      console.log(`\nEnvironment info written to: ${outputPath}\n`);
    },
  };
}
