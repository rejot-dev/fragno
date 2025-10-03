import type { BuildTools } from "./index";

const unpluginFragnoVersion = "^0.0.1";

export const buildToolPkg: Record<BuildTools, Record<string, unknown>> = {
  none: {},
  tsdown: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      tsdown: "^0.11.9",
    },
    scripts: {
      build: "tsdown",
    },
  },
  esbuild: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      esbuild: "^0.25.10",
    },
    scripts: {
      build: "./esbuild.config.js",
    },
  },
  vite: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      vite: "^6.0.0",
    },
    scripts: {
      build: "vite build",
    },
  },
  rollup: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      "@rollup/plugin-typescript": "^12.1.4",
      tslib: "^2.8.1",
      rollup: "^4.52.4",
    },
    scripts: {
      build: "rollup -c",
    },
  },
};
