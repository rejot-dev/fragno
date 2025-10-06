import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/mod.ts", "./src/schema/create.ts", "./src/adapters/kysely/kysely-adapter.ts"],
  dts: true,
  unbundle: true,
});
