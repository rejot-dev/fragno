import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";
import { coverageConfigDefaults } from "vitest/config";

export default defineConfig(
  mergeConfig(baseConfig, {
    test: {
      environment: "node",
      coverage: {
        exclude: [
          ...coverageConfigDefaults.exclude,
          // Exclude the script files that aren't library code
          "src/publish-packages.ts",
          "*.ts", // Exclude root-level script files
        ],
        include: ["src/util/**/*.ts"],
        reporter: [["json", { file: "coverage.json" }]],
      },
    },
  }),
);
