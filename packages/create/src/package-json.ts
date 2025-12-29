import type { BuildTools } from "./index";

const fragnoCoreVersion = "0.1.11";
const fragnoDbVersion = "0.2.2";
const unpluginFragnoVersion = "0.0.7";
const fragnoCliVersion = "0.1.23";

export const basePkg: Record<string, unknown> = {
  dependencies: {
    "@fragno-dev/core": fragnoCoreVersion,
    "@standard-schema/spec": "^1.0.0",
    zod: "^4.0.5",
  },
  devDependencies: {
    "@types/node": "^24",
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
      tsdown: "^0.12.0",
    },
    scripts: {
      build: "tsdown",
    },
  },
  esbuild: {
    devDependencies: {
      esbuild: "^0.25.12",
    },
    scripts: {
      build: "./esbuild.config.js",
    },
  },
  vite: {
    devDependencies: {
      vite: "^6.3.5",
    },
    scripts: {
      build: "vite build",
    },
  },
  rollup: {
    devDependencies: {
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
      "@rspack/core": "^1.6.1",
      "@rspack/cli": "^1.6.1",
    },
    scripts: {
      build: "rspack build",
    },
  },
};
