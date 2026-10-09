import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/api.ts",
    "./src/errors.ts",
    "./src/openapi.ts",
    "./src/v0/*.ts",
    "./src/v0/shared/*.ts",
    "!./src/**/*.test.ts",
  ],
  dts: true,
  unbundle: true,
});
