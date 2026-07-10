import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["src/index.ts", "src/macros.ts", "src/types.ts", "src/integrations/*.ts"],
});
