import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/mod.ts",
    "./src/api/api.ts",
    "./src/client/client.ts",
    "./src/client/vanilla.ts",
    "./src/client/client.svelte.ts",
    "./src/client/react.ts",
    "./src/client/vue.ts",
    "./src/client/solid.ts",
    "./src/integrations/astro.ts",
    "./src/integrations/next-js.ts",
    "./src/integrations/react-ssr.ts",
    "./src/integrations/svelte-kit.ts",
  ],
  dts: true,
  // TODO: This should be true, but we need some additional type exports in chatno/src/index.ts
  // to make it work.
  unbundle: false,
});
