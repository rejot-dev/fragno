// @ts-check

import eslint from "@eslint/js";
import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginReact from "eslint-plugin-react";
import eslintPluginTailwindcss from "eslint-plugin-tailwindcss";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  globalIgnores([
    "**/samples/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/build/**",
    "**/.react-router/**",
    "**/worker-configuration.d.ts",
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
  {
    name: "graph: React (library)",
    files: ["packages/graph/**/*.{ts,tsx}"],
    plugins: {
      react: eslintPluginReact,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...eslintPluginReact.configs.recommended.rules,
      ...eslintPluginReact.configs["jsx-runtime"].rules,
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    name: "graph-test: React + Tailwind",
    files: ["packages/graph-test/**/*.{ts,tsx}"],
    plugins: {
      react: eslintPluginReact,
      tailwindcss: eslintPluginTailwindcss,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...eslintPluginReact.configs.recommended.rules,
      ...eslintPluginReact.configs["jsx-runtime"].rules,
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        {
          ignore: ["x-chunk"],
        },
      ],
      ...eslintPluginTailwindcss.configs["recommended"].rules,
      // Fixed by prettier tailwind
      "tailwindcss/classnames-order": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
      tailwindcss: {
        config: "./packages/graph-test/tailwind.config.js",
      },
    },
  },
  {
    name: "ai-analyzer-spa: React + Tailwind",
    files: ["packages/ai-analyzer-spa/**/*.{ts,tsx}"],
    plugins: {
      react: eslintPluginReact,
      tailwindcss: eslintPluginTailwindcss,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...eslintPluginReact.configs.recommended.rules,
      ...eslintPluginReact.configs["jsx-runtime"].rules,
      "react/react-in-jsx-scope": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "react/no-unknown-property": [
        "error",
        {
          ignore: ["x-chunk"],
        },
      ],
      ...eslintPluginTailwindcss.configs["recommended"].rules,
      // Fixed by prettier tailwind
      "tailwindcss/classnames-order": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
      tailwindcss: {
        config: "./packages/ai-analyzer-spa/tailwind.config.cjs",
      },
    },
  },
  {
    name: "recivo: React + Tailwind",
    files: ["packages/recivo/**/*.{ts,tsx}"],
    plugins: {
      react: eslintPluginReact,
      tailwindcss: eslintPluginTailwindcss,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...eslintPluginReact.configs.recommended.rules,
      ...eslintPluginReact.configs["jsx-runtime"].rules,
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        {
          ignore: ["x-chunk"],
        },
      ],
      ...eslintPluginTailwindcss.configs["recommended"].rules,
      // Fixed by prettier tailwind
      "tailwindcss/classnames-order": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
);
