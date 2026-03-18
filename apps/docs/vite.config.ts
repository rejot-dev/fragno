import path from "path";

import { reactRouter } from "@react-router/dev/vite";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

import * as MdxConfig from "./source.config";

const fumadocsDeps = [
  "fumadocs-ui/components/callout",
  "fumadocs-ui/components/steps",
  "fumadocs-ui/components/card",
  "fumadocs-ui/components/type-table",
  "fumadocs-ui/components/codeblock",
  "fumadocs-ui/components/tabs",
  "fumadocs-ui/components/dynamic-codeblock",
  "fumadocs-ui/components/ui/popover",
  "fumadocs-ui/contexts/search",
  "fumadocs-ui/layouts/home",
  "fumadocs-ui/layouts/docs",
  "fumadocs-ui/page",
  "fumadocs-ui/provider/react-router",
  "fumadocs-ui/utils/use-copy-button",
  "fumadocs-core/highlight/client",
  "hast-util-to-jsx-runtime",
  "lucide-react",
  "@marsidev/react-turnstile",
];

function getDocsBuildTarget(value = process.env.FRAGNO_DOCS_TARGET) {
  if (value === undefined) {
    return "all";
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "all" || normalizedValue === "docs" || normalizedValue === "backoffice") {
    return normalizedValue;
  }

  throw new Error(
    `Invalid FRAGNO_DOCS_TARGET value: ${value}. Expected one of: all, docs, backoffice.`,
  );
}

const buildTarget = getDocsBuildTarget();
const workerConfigPath =
  buildTarget === "backoffice" ? "./wrangler.backoffice.jsonc" : "./wrangler.docs.jsonc";
const workerWarmupFiles =
  buildTarget === "backoffice" ? ["./workers/backoffice.ts"] : ["./workers/docs.ts"];

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";

  return {
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@/components": path.resolve(__dirname, "./app/components"),
        "@/lib": path.resolve(__dirname, "./app/lib"),
        ajv: path.resolve(__dirname, "./shims/ajv.ts"),
        "ajv-formats": path.resolve(__dirname, "./shims/ajv-formats.ts"),
        undici: path.resolve(__dirname, "./shims/undici.ts"),
      },
    },
    plugins: [
      mdx(MdxConfig),
      cloudflare({ configPath: workerConfigPath, viteEnvironment: { name: "ssr" } }),
      tailwindcss(),
      reactRouter(),
      devtoolsJson(),
    ],
    optimizeDeps: isDev
      ? {
          include: fumadocsDeps,
        }
      : undefined,
    ssr: {
      ...(isDev
        ? {
            optimizeDeps: {
              include: fumadocsDeps,
            },
          }
        : {}),
      noExternal: ["@mariozechner/pi-ai"],
    },
    server: {
      allowedHosts: ["local-wilco.recivo.email"],
      headers: isDev
        ? {
            "Cache-Control": "no-store",
          }
        : undefined,
      warmup: isDev
        ? {
            ssrFiles: workerWarmupFiles,
          }
        : undefined,
    },
  };
});
