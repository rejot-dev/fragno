import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export const docsVitestResolveConfig = {
  alias: [
    {
      find: /^@\//,
      replacement: `${path.resolve(rootDir, "app")}/`,
    },
    {
      find: "ajv",
      replacement: path.resolve(rootDir, "shims/ajv.ts"),
    },
    {
      find: "ajv-formats",
      replacement: path.resolve(rootDir, "shims/ajv-formats.ts"),
    },
    {
      find: "svix",
      replacement: path.resolve(rootDir, "shims/svix.ts"),
    },
    {
      find: "undici",
      replacement: path.resolve(rootDir, "shims/undici.ts"),
    },
  ],
};
