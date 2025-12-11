import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";
import path from "path";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@/components": path.resolve(__dirname, "../../example-apps/stripe-webshop/src/components"),
        "@/lib": path.resolve(__dirname, "../../example-apps/stripe-webshop/src/lib"),
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
    },
  }),
);
