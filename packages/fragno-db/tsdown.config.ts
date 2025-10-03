import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/mod.ts", "./src/schema/create.ts"],
  dts: true,
  unbundle: true,
});
