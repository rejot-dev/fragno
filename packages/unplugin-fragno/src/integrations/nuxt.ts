import type { Options } from "../types";
import { addVitePlugin, addWebpackPlugin, defineNuxtModule } from "@nuxt/kit";
import vite from "./vite.ts";
import webpack from "./webpack";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModuleOptions extends Options {}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "nuxt-unplugin-fragno",
    configKey: "unpluginStarter",
  },
  defaults: {
    // ...default options
  },
  setup(options, _nuxt) {
    addVitePlugin(() => vite(options));
    addWebpackPlugin(() => webpack(options));

    // ...
  },
});
