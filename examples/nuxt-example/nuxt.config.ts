// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  nitro: {
    typescript: {
      tsConfig: {
        references: [
          {
            path: "../../../packages/fragno",
          },
          {
            path: "../../../packages/example-fragment",
          },
        ],
      },
    },
  },
  typescript: {
    tsConfig: {
      references: [
        {
          path: "../../../packages/fragno",
        },
        {
          path: "../../../packages/example-fragment",
        },
      ],
    },
  },
  vite: {
    optimizeDeps: {
      include: ["zod"],
    },
    ssr: {
      noExternal: ["zod"],
    },
  },
});
