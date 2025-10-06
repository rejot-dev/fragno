import { defineConfig, mergeConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default mergeConfig(
  defineConfig({
    plugins: [svelte(), svelteTesting()],
    test: {
      environment: "happy-dom",
    },
  }),
);
