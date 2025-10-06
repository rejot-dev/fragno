import { coverageConfigDefaults, type UserConfig } from "vitest/config";

export const baseConfig = {
  test: {
    globals: true,
    coverage: {
      provider: "istanbul" as const,
      exclude: ["packages/create/templates/**", ...coverageConfigDefaults.exclude],
      reporter: [["json", { file: `../coverage.json` }] as const],
      enabled: true,
    },
  },
} satisfies UserConfig;
