import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig(
  mergeConfig(baseConfig, {
    plugins: [svelte(), svelteTesting()],
    test: {
      environment: "happy-dom",
    },
  }),
);
