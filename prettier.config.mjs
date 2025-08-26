/** @type {import('prettier').Config} */
const prettierConfig = {
  singleQuote: false,
  semi: true,
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  proseWrap: "always",
  trailingComma: "all",
  plugins: [
    "prettier-plugin-embed",
    "prettier-plugin-sql",
    "prettier-plugin-tailwindcss",
    "prettier-plugin-astro",
  ],
  overrides: [
    {
      files: "*.astro",
      options: {
        parser: "astro",
      },
    },
  ],
};

/** @type {import('prettier-plugin-embed').PrettierPluginEmbedOptions} */
const prettierPluginEmbedConfig = {
  // TODO(Wilco): we can try using https://gist.github.com/Sharaal/742b0537035720dba7bc85b6bc7854c5 to support node-postgres better.
  embeddedSqlTags: ["sql"],
};

/** @type {import('prettier-plugin-sql').SqlBaseOptions} */
const prettierPluginSqlConfig = {
  language: "sqlite",
  keywordCase: "upper",
};

export default {
  ...prettierConfig,
  ...prettierPluginEmbedConfig,
  ...prettierPluginSqlConfig,
};
