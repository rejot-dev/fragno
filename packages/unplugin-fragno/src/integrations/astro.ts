import type { Options } from "../types";

import unplugin from "..";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (options: Options): any => ({
  name: "unplugin-fragno",
  hooks: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "astro:config:setup": async (astro: any) => {
      astro.config.vite.plugins ||= [];
      astro.config.vite.plugins.push(unplugin.vite(options));
    },
  },
});
