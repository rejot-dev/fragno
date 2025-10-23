import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/mod.ts", "./src/upvote.ts"],
    dts: true,
    platform: "node",
    outDir: "./dist",
  },
]);
