import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "packages-private/*",
      // Exclude SvelteKit example as it doesn't have tests and interferes with other projects
      // "examples/svelte-kit-example",
      "examples/astro-example",
      "examples/nextjs-example",
      "examples/nuxt-example",
      "examples/react-router-example",
      "examples/vue-spa-example",
    ],
  },
});
