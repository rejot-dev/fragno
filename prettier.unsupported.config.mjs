/** @type {import("prettier").Config} */
export default {
  singleQuote: false,
  semi: true,
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  proseWrap: "always",
  trailingComma: "all",
  plugins: [
    "prettier-plugin-sql",
    "prettier-plugin-tailwindcss",
    "prettier-plugin-astro",
    "prettier-plugin-svelte",
  ],
  overrides: [
    {
      files: "*.astro",
      options: {
        parser: "astro",
      },
    },
    {
      files: "*.svelte",
      options: {
        parser: "svelte",
      },
    },
  ],
  language: "sqlite",
  keywordCase: "upper",
};
