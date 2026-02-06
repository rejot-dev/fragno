import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/mod.ts", "./src/upvote.ts", "./src/schema/mod.ts"],
    dts: true,
    platform: "node",
    outDir: "./dist",
  },
]);
