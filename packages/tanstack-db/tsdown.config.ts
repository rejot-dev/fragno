import { defineConfig } from "tsdown";

export default defineConfig([
  {
    fixedExtension: false,
    entry: ["./src/stream-db.ts"],
    dts: true,
    platform: "browser",
    unbundle: true,
  },
]);
