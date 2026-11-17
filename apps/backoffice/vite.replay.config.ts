// The universe replay app (replay/), for working on the universe against organizations recorded
// from a Leyway server:
//
//   pnpm --filter @fragno-apps/backoffice-rr universe-replay:capture org:rejot
//   pnpm --filter @fragno-apps/backoffice-rr universe-replay
//
// It is Backoffice's universe panel without Backoffice: no Workers, sign-in or local data, only the
// replay middleware standing in for the recorded scopes' Automations backends.
import path from "node:path";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";
import { defineConfig } from "vite";

import tailwindcss from "@tailwindcss/vite";

import { universeReplayPlugin } from "./scripts/universe-replay/vite-plugin";

export default defineConfig({
  root: path.resolve(__dirname, "replay"),
  base: "/replay/",
  define: {
    "import.meta.env.BACKOFFICE_TARGET": JSON.stringify("cloudflare"),
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
    alias: {
      "@/components": path.resolve(__dirname, "./app/components"),
      "@/lib": path.resolve(__dirname, "./app/lib"),
      ajv: path.resolve(__dirname, "./shims/ajv.ts"),
      "ajv-formats": path.resolve(__dirname, "./shims/ajv-formats.ts"),
      undici: path.resolve(__dirname, "./shims/undici.ts"),
    },
  },
  plugins: [universeReplayPlugin(), tailwindcss()],
  server: {
    // Loopback only, also on boxd VMs: recordings hold real events, and boxd's proxies are public.
    host: "127.0.0.1",
    // Beside the worktree's Backoffice ports: the dev server's, and its inspector's at +10000.
    port: backofficeDevServerPort(__dirname) + 20_000,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, "../..")] },
  },
});
