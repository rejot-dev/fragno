import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  splitRouteModules: true,
  buildDirectory:
    process.env.BACKOFFICE_TARGET === "graft"
      ? "build-graft"
      : process.env.BACKOFFICE_TARGET === "node"
        ? "build-node"
        : "build",
} satisfies Config;
