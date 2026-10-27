import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Pre-bundling moves wa-sqlite away from the URL it loads its wasm from.
    exclude: ["@journeyapps/wa-sqlite"],
  },
});
