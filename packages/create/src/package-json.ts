import type { BuildTools } from "./index";

const fragnoCoreVersion = "0.2.0";
const fragnoDbVersion = "0.3.0";
const unpluginFragnoVersion = "0.0.8";
const fragnoCliVersion = "0.2.0";

export const basePkg: Record<string, unknown> = {
  dependencies: {
    "@fragno-dev/core": fragnoCoreVersion,
    "@standard-schema/spec": "^1.1.0",
    zod: "^4.3.6",
  },
  devDependencies: {
    "@types/node": "^25.2.2",
    "@fragno-dev/cli": fragnoCliVersion,
    "@fragno-dev/unplugin-fragno": unpluginFragnoVersion,
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
      tsdown: "^0.20.3",
    },
    scripts: {
      build: "tsdown",
    },
  },
  esbuild: {
    devDependencies: {
      esbuild: "^0.27.3",
    },
    scripts: {
      build: "./esbuild.config.js",
    },
  },
  vite: {
    devDependencies: {
      vite: "^7.3.1",
    },
    scripts: {
      build: "vite build",
    },
  },
  rollup: {
    devDependencies: {
      "@rollup/plugin-node-resolve": "^16.0.3",
      "@rollup/plugin-typescript": "^12.3.0",
      tslib: "^2.8.1",
      rollup: "^4.57.1",
    },
    scripts: {
      build: "rollup -c",
    },
  },
  webpack: {
    devDependencies: {
      webpack: "^5.105.0",
      "webpack-cli": "^6.0.1",
      "ts-loader": "^9.5.4",
    },
    scripts: {
      build: "webpack",
    },
  },
  rspack: {
    devDependencies: {
      "@rspack/core": "^1.7.5",
      "@rspack/cli": "^1.7.5",
    },
    scripts: {
      build: "rspack build",
    },
  },
};
