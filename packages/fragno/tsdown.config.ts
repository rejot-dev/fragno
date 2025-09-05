import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/mod.ts",
    "./src/api/api.ts",
    "./src/client/client.ts",
    "./src/client/vanilla.ts",
    "./src/client/react.ts",
    "./src/client/vue.ts",
    "./src/integrations/astro.ts",
    "./src/integrations/next-js.ts",
    "./src/integrations/react-ssr.ts",
  ],
  dts: true,
});
