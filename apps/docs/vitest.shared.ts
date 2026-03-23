import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export const docsVitestResolveConfig = {
  alias: [
    {
      find: /^@\//,
      replacement: `${path.resolve(rootDir, "app")}/`,
    },
  ],
};
