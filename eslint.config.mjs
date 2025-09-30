// @ts-check

import eslint from "@eslint/js";
import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "**/samples/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/build/**",
    "**/.react-router/**",
    "**/.svelte-kit/**",
    "**/.nuxt/**",
    "**/.turbo/**",
    "**/.next/**",
    "**/.output/**",
    "**/worker-configuration.d.ts",
    "**/.astro/**",
    "**/next-env.d.ts",
    "packages/docs/.source/**",
  ]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-unused-expressions": [
        "error",
        {
          allowShortCircuit: false,
        },
      ],
    },
  },
);
