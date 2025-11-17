import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/mod.ts",
    "./src/api/api.ts",
    "./src/api/shared-types.ts",
    "./src/api/fragment-definition-builder.ts",
    "./src/api/fragment-instantiator.ts",
    "./src/api/route.ts",
    "./src/api/request-context-storage.ts",
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
    "./src/test/test.ts",
  ],
  dts: true,
  unbundle: true,
});
