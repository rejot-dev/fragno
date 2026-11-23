import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// Generates the icons browsers and phones ask for beside the SVG favicon: favicon.ico, the iOS
// home-screen icon, and the web manifest's icons. Run `pnpm favicons:generate` after changing
// public/favicon.svg, and commit what it writes to public/.
export default defineConfig({
  preset: minimal2023Preset,
  images: ["public/favicon.svg"],
});
