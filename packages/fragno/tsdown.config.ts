import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/mod.ts",
    "./src/api/api.ts",
    "./src/client/client.ts",
    "./src/client/vanilla.ts",
    "./src/client/react.ts",
    "./src/client/vue.ts",
    "./src/client/astro.ts",
  ],
  dts: true,
});
