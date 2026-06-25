// https://nuxt.com/docs/api/configuration/nuxt-config

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  telemetry: false,
  vite: {
    optimizeDeps: {
      include: ["zod"],
    },
    ssr: {
      noExternal: ["zod"],
    },
  },
});
