import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import mdx from "fumadocs-mdx/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import * as MdxConfig from "./source.config";

export default defineConfig(() => {
  return {
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
