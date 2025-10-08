import { coverageConfigDefaults } from "vitest/config";

const baseConfig = {
  test: {
    globals: true,
    coverage: {
      provider: "istanbul",
      exclude: ["templates/**", ...coverageConfigDefaults.exclude],
      reporter: [["json", { file: `../coverage.json` }]],
      enabled: true,
    },
  },
};

export { baseConfig };
