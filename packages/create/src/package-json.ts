import type { BuildTools } from "./index";

const fragnoCoreVersion = "^0.1.7";
const fragnoDbVersion = "^0.1.13";
const unpluginFragnoVersion = "^0.0.3";
const fragnoCliVersion = "^0.1.16";

export const basePkg: Record<string, unknown> = {
  dependencies: {
    "@fragno-dev/core": fragnoCoreVersion,
    zod: "^4.1.12",
  },
  devDependencies: {
    "@types/node": "^22",
    "@fragno-dev/cli": fragnoCliVersion,
  },
  peerDependencies: {
    typescript: ">=5",
    react: ">=18.0.0",
    svelte: ">=4.0.0",
    "solid-js": ">=1.0.0",
    vue: ">=3.0.0",
  },
};

export const databasePkg: Record<string, unknown> = {
  devDependencies: {
    "@fragno-dev/db": fragnoDbVersion,
  },
  peerDependencies: {
    "@fragno-dev/db": fragnoDbVersion,
  },
};

export const buildToolPkg: Record<BuildTools, Record<string, unknown>> = {
  none: {},
  tsdown: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      tsdown: "^0.12.0",
    },
    scripts: {
      build: "tsdown",
    },
  },
  esbuild: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      esbuild: "^0.25.12",
    },
    scripts: {
      build: "./esbuild.config.js",
    },
  },
  vite: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      vite: "^6.3.5",
    },
    scripts: {
      build: "vite build",
    },
  },
  rollup: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      "@rollup/plugin-node-resolve": "^16.0.2",
      "@rollup/plugin-typescript": "^12.1.4",
      tslib: "^2.8.1",
      rollup: "^4.41.0",
    },
    scripts: {
      build: "rollup -c",
    },
  },
  webpack: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      webpack: "^5.99.9",
      "webpack-cli": "^6.0.1",
      "ts-loader": "^9.5.1",
    },
    scripts: {
      build: "webpack",
    },
  },
  rspack: {
    devDependencies: {
      "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
      "@rspack/core": "^1.6.1",
      "@rspack/cli": "^1.6.1",
    },
    scripts: {
      build: "rspack build",
    },
  },
};
