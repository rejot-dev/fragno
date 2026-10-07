import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 6174, strictPort: true },
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter()],
});
