import path from "node:path";

import type { Plugin } from "vite";
import { unstable_getVarsForDev } from "wrangler";

import { getReactRouterWorkerEntries } from "../workers/react-router-worker-routing";

const routeWorkerByViteEnvironmentName = new Map(
  getReactRouterWorkerEntries().map(([workerId, worker]) => [`routes_${workerId}`, worker]),
);

type SecretTextBinding = {
  type: "secret_text";
  value: string;
};

/** Emits each route Worker's locally configured secrets for `vite preview`. */
export function reactRouterWorkerPreviewDevVarsVitePlugin(): Plugin {
  let wranglerConfigPath = "";

  return {
    name: "backoffice-react-router-worker-preview-dev-vars",
    apply: "build",
    configResolved(config) {
      wranglerConfigPath = path.join(config.root, "wrangler.jsonc");
    },
    generateBundle() {
      const worker = routeWorkerByViteEnvironmentName.get(this.environment.name);
      if (!worker) {
        return;
      }

      const source = createReactRouterWorkerPreviewDevVars({
        wranglerConfigPath,
        secretNames: [
          ...worker.environment.secrets.required,
          ...worker.environment.secrets.optional,
        ],
      });
      if (source === null) {
        return;
      }

      this.emitFile({
        type: "asset",
        fileName: ".dev.vars",
        source,
      });
    },
  };
}

/** Creates a filtered `.dev.vars` file without granting unrelated secrets to a route Worker. */
export function createReactRouterWorkerPreviewDevVars(input: {
  wranglerConfigPath: string;
  secretNames: readonly string[];
}): string | null {
  const bindings = unstable_getVarsForDev(
    input.wranglerConfigPath,
    undefined,
    {},
    undefined,
    true,
    { required: [...input.secretNames] },
  ) as Record<string, SecretTextBinding>;

  const lines = input.secretNames.flatMap((secretName) => {
    const binding = bindings[secretName];
    return binding ? [`${secretName}=${quotePreviewDevVar(binding.value)}\n`] : [];
  });
  return lines.length > 0 ? lines.join("") : null;
}

function quotePreviewDevVar(value: string) {
  // Wrangler's dotenv parser supports all three quote styles, so choose one that preserves the
  // secret verbatim rather than escaping content that may have meaning to the parser.
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes("`")) {
    return `\`${value}\``;
  }
  if (!value.includes('"') && !/[\\\n\r]/.test(value)) {
    return `"${value}"`;
  }
  throw new Error(
    "Backoffice preview secret cannot be serialized to .dev.vars without changing its value.",
  );
}
