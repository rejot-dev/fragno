import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildCloudflareScriptTags,
  createCloudflareApiClient,
  deployCloudflareWorker,
} from "../../../packages/cloudflare-fragment/src/cloudflare-api.ts";
import { buildCloudflareAppTag } from "../../../packages/cloudflare-fragment/src/deployment-tag.ts";
import { resolveCloudflareScriptName } from "../../../packages/cloudflare-fragment/src/script-name.ts";

type CliOptions = {
  orgId: string | null;
  appId: string;
  namespace: string | null;
  baseUrl: string;
  help: boolean;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_APP_ROOT = resolve(SCRIPT_DIR, "..");
const DEV_VARS_PATH = resolve(DOCS_APP_ROOT, ".dev.vars");
const WRANGLER_CONFIG_PATH = resolve(DOCS_APP_ROOT, "wrangler.jsonc");
const DEFAULT_APP_ID = "debug";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_NAMESPACE = "staging";

const printUsage = () => {
  console.log(`Upload a tiny debug worker into the docs app dispatch namespace.

Usage:
  pnpm --filter ./apps/docs run cloudflare:debug-worker -- --org <orgId> [--app <appId>]
  pnpm --filter ./apps/docs exec tsx scripts/upload-debug-dispatch-worker.ts --org <orgId>

Options:
  --org, -o         Backoffice organisation id. Required.
  --app, -a         Worker app id used in the script name and local proxy URL. Default: ${DEFAULT_APP_ID}
  --namespace, -n   Dispatch namespace name. Defaults to the namespace in wrangler.jsonc.
  --base-url, -b    Base URL for the local docs dev server. Default: ${DEFAULT_BASE_URL}
  --help, -h        Show this help output.

Examples:
  pnpm --filter ./apps/docs run cloudflare:debug-worker -- --org ca97xhxao6bycevwovtuf8ro
  pnpm --filter ./apps/docs run cloudflare:debug-worker -- --org ca97xhxao6bycevwovtuf8ro --app echo
`);
};

const readTextArg = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const readRequiredOptionArg = (argv: string[], index: number, optionName: string) => {
  const candidate = argv[index + 1];
  if (candidate === undefined || candidate.startsWith("-")) {
    throw new Error(`Missing value for ${optionName}.`);
  }

  const value = readTextArg(candidate);
  if (value === null) {
    throw new Error(`Missing value for ${optionName}.`);
  }

  return value;
};

export const parseCliArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    orgId: null,
    appId: DEFAULT_APP_ID,
    namespace: null,
    baseUrl: DEFAULT_BASE_URL,
    help: false,
  };

  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--org":
      case "-o":
        options.orgId = readRequiredOptionArg(argv, index, arg);
        index += 1;
        break;
      case "--app":
      case "-a":
        options.appId = readRequiredOptionArg(argv, index, arg);
        index += 1;
        break;
      case "--namespace":
      case "-n":
        options.namespace = readRequiredOptionArg(argv, index, arg);
        index += 1;
        break;
      case "--base-url":
      case "-b":
        options.baseUrl = readRequiredOptionArg(argv, index, arg);
        index += 1;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        positionals.push(arg);
        break;
    }
  }

  if (options.orgId === null && positionals.length > 0) {
    options.orgId = readTextArg(positionals.shift());
  }

  if (positionals.length > 0) {
    options.appId = readTextArg(positionals.shift()) ?? DEFAULT_APP_ID;
  }

  if (positionals.length > 0) {
    throw new Error(`Unexpected extra arguments: ${positionals.join(" ")}`);
  }

  return options;
};

const loadDevVars = (filePath: string) => {
  if (!existsSync(filePath)) {
    return;
  }

  const source = readFileSync(filePath, "utf8");

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = line.slice(separatorIndex + 1);
  }
};

type WranglerConfig = {
  compatibility_date?: unknown;
  dispatch_namespaces?: unknown;
  env?: Record<string, WranglerConfig | undefined>;
};

const readConfiguredWranglerEnv = () => {
  return readTextArg(process.env.WRANGLER_ENV) ?? readTextArg(process.env.CLOUDFLARE_ENV);
};

const stripJsonComments = (jsonc: string) => {
  let result = "";
  let inString = false;
  let isEscaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < jsonc.length; index += 1) {
    const current = jsonc[index];
    const next = jsonc[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (current === "\n") {
        result += current;
      }
      continue;
    }

    if (inString) {
      result += current;

      if (isEscaping) {
        isEscaping = false;
      } else if (current === "\\") {
        isEscaping = true;
      } else if (current === '"') {
        inString = false;
      }

      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
};

const stripTrailingCommas = (json: string) => {
  let result = "";
  let inString = false;
  let isEscaping = false;

  for (let index = 0; index < json.length; index += 1) {
    const current = json[index];

    if (inString) {
      result += current;

      if (isEscaping) {
        isEscaping = false;
      } else if (current === "\\") {
        isEscaping = true;
      } else if (current === '"') {
        inString = false;
      }

      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === ",") {
      const rest = json.slice(index + 1);
      const nextNonWhitespace = rest.match(/\S/u)?.[0];
      if (nextNonWhitespace === "}" || nextNonWhitespace === "]") {
        continue;
      }
    }

    result += current;
  }

  return result;
};

export const parseWranglerConfig = (source: string): WranglerConfig => {
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("wrangler.jsonc must contain a JSON object.");
  }

  return parsed as WranglerConfig;
};

const readWranglerConfig = () => {
  if (!existsSync(WRANGLER_CONFIG_PATH)) {
    return null;
  }

  return parseWranglerConfig(readFileSync(WRANGLER_CONFIG_PATH, "utf8"));
};

const readTrimmedString = (value: unknown) => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const readWranglerEnvConfig = (config: WranglerConfig | null, envName?: string | null) => {
  if (!config || !envName) {
    return null;
  }

  const envConfig = config.env?.[envName];
  return envConfig && typeof envConfig === "object" && !Array.isArray(envConfig) ? envConfig : null;
};

export const readWranglerStringValue = (
  config: WranglerConfig | null,
  key: "compatibility_date",
  envName?: string | null,
) => {
  const envConfig = readWranglerEnvConfig(config, envName);
  return readTrimmedString(envConfig?.[key]) ?? readTrimmedString(config?.[key]);
};

export const readDispatchNamespaceFromWranglerConfig = (
  config: WranglerConfig | null,
  envName?: string | null,
) => {
  const readNamespace = (value: unknown) => {
    if (!Array.isArray(value)) {
      return null;
    }

    const entry = value[0];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    return readTrimmedString((entry as { namespace?: unknown }).namespace);
  };

  const envConfig = readWranglerEnvConfig(config, envName);
  return (
    readNamespace(envConfig?.dispatch_namespaces) ?? readNamespace(config?.dispatch_namespaces)
  );
};

const readRequiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Set it in apps/docs/.dev.vars or your shell environment.`);
  }

  return value;
};

const normalizeBaseUrl = (value: string) => {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const buildLocalProxyUrl = (baseUrl: string, orgId: string, appId: string) => {
  const url = normalizeBaseUrl(baseUrl);
  url.pathname = `/__dev/workers/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}/`;
  return url.toString();
};

const buildDebugWorkerSource = (input: {
  orgId: string;
  appId: string;
  scriptName: string;
  dispatchNamespace: string;
  compatibilityDate: string;
}) => {
  const metadataLiteral = JSON.stringify(input, null, 2);

  return `const metadata = ${metadataLiteral};

const MAX_BODY_LENGTH = 4096;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let bodyText = null;

    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        const text = await request.text();
        bodyText = text.length > MAX_BODY_LENGTH ? text.slice(0, MAX_BODY_LENGTH) + "..." : text;
      } catch (error) {
        bodyText = error instanceof Error ? error.message : "Unable to read request body.";
      }
    }

    return Response.json(
      {
        ok: true,
        metadata,
        request: {
          method: request.method,
          url: url.toString(),
          pathname: url.pathname,
          search: url.search,
          contentType: request.headers.get("content-type"),
          authorizationPresent: request.headers.has("authorization"),
          forwardedOrgId: request.headers.get("x-fragno-worker-org-id"),
          forwardedAppId: request.headers.get("x-fragno-worker-app-id"),
          forwardedScriptName: request.headers.get("x-fragno-worker-script-name"),
          bodyText,
        },
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  },
};
`;
};

const formatCloudflareResponseValue = (value: string | number | null | undefined) => {
  if (value === undefined || value === null || value === "") {
    return "n/a";
  }

  return String(value);
};

const main = async () => {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.orgId) {
    printUsage();
    throw new Error("Missing required --org <orgId> argument.");
  }

  loadDevVars(DEV_VARS_PATH);

  const wranglerConfig = readWranglerConfig();
  const wranglerEnv = readConfiguredWranglerEnv();
  const accountId = readRequiredEnv("CLOUDFLARE_WORKERS_ACCOUNT_ID");
  const apiToken = readRequiredEnv("CLOUDFLARE_WORKERS_API_TOKEN");
  const dispatchNamespace =
    options.namespace ??
    readDispatchNamespaceFromWranglerConfig(wranglerConfig, wranglerEnv) ??
    DEFAULT_NAMESPACE;
  const compatibilityDate =
    readWranglerStringValue(wranglerConfig, "compatibility_date", wranglerEnv) ??
    new Date().toISOString().slice(0, 10);
  const scriptName = resolveCloudflareScriptName(options.appId, {
    scriptNamePrefix: `fragno-${options.orgId}`,
    scriptNameSuffix: "worker",
  });
  const moduleContent = buildDebugWorkerSource({
    orgId: options.orgId,
    appId: options.appId,
    scriptName,
    dispatchNamespace,
    compatibilityDate,
  });
  const client = createCloudflareApiClient({
    apiToken,
  });
  const tags = buildCloudflareScriptTags(
    [buildCloudflareAppTag(options.appId, `fragno-${options.orgId}`), "debug-upload"],
    [],
  );

  const response = await deployCloudflareWorker(client, {
    accountId,
    dispatchNamespace,
    scriptName,
    entrypoint: "index.mjs",
    moduleContent,
    compatibilityDate,
    compatibilityFlags: [],
    tags,
  });

  const proxyUrl = buildLocalProxyUrl(options.baseUrl, options.orgId, options.appId);

  console.log(
    `Uploaded debug worker '${scriptName}' to dispatch namespace '${dispatchNamespace}'.`,
  );
  console.log(`Cloudflare script id: ${formatCloudflareResponseValue(response.id)}`);
  console.log(`Cloudflare etag: ${formatCloudflareResponseValue(response.etag)}`);
  console.log(`Cloudflare modified_on: ${formatCloudflareResponseValue(response.modified_on)}`);
  console.log(
    `Cloudflare startup_time_ms: ${formatCloudflareResponseValue(response.startup_time_ms)}`,
  );
  console.log(`Local dev proxy URL: ${proxyUrl}`);
  console.log(`Try: curl '${proxyUrl}?hello=world'`);
};

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
