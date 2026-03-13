import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Fix globby/unicorn-magic incompatibility in Vite's dep optimization
      // unicorn-magic exports toPath only from node.js, not default.js
      "unicorn-magic": "unicorn-magic/node",
    },
  },
  // Needed for 'Could not resolve "#tanstack-router-entry"' type errors
  optimizeDeps: {
    exclude: ["@tanstack/start-server-core", "@tanstack/react-start", "@tanstack/react-router"],
  },
});

export default config;
