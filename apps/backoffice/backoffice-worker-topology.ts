type BackofficeSecretDefinition = {
  /** Secret names emitted as Wrangler `secrets.required` for deployment validation. */
  required: readonly string[];
  /** Secret names accepted by the Worker without being required for deployment. */
  optional: readonly string[];
};

type BackofficeEnvironmentDefinition = {
  variables: readonly string[];
  secrets: BackofficeSecretDefinition;
};

type BackofficeEntryWorkerDefinition = {
  name: string;
  environment: BackofficeEnvironmentDefinition;
};

type BackofficeReactRouterWorkerDefinition = {
  /** Cloudflare Worker script name used by auxiliary deployment and service bindings. */
  name: string;
  /** Entry Worker binding that dispatches requests to this route Worker. */
  serviceBinding: `ROUTES_${string}`;
  /** Exact leaf route module paths, relative to the Backoffice `app` directory, owned by this Worker. */
  routeModules: readonly string[];
  /** App-relative prefixes that assign every matching leaf route module to this Worker. */
  routeModulePrefixes: readonly string[];
  /** URL path boundaries that dispatch matching requests to this Worker. */
  requestPathPrefixes: readonly string[];
  /** JavaScript regular expression sources for request paths not expressible as fixed boundaries. */
  requestPathRegularExpressions: readonly string[];
  /** URL path boundaries removed from this Worker's broader request matches. */
  excludedRequestPathPrefixes: readonly string[];
  /** JavaScript regular expression sources removed from this Worker's broader request matches. */
  excludedRequestPathRegularExpressions: readonly string[];
  /** Variables and secrets made available to this independently deployed Worker. */
  environment: BackofficeEnvironmentDefinition;
};

type BackofficeWorkerTopology = {
  /** React Router Worker id receiving requests unmatched by every explicit request selector. */
  fallbackRequestHandler: string;
  entryWorker: BackofficeEntryWorkerDefinition;
  reactRouterWorkers: Record<string, BackofficeReactRouterWorkerDefinition>;
};

const sharedReactRouterVariables = [
  "AUTH_EMAIL_VERIFICATION_ENABLED",
  "DOCS_PUBLIC_BASE_URL",
] as const;

/** Declares Backoffice deployment Workers, route ownership, bindings, and environment grants. */
export const BACKOFFICE_WORKER_TOPOLOGY = {
  fallbackRequestHandler: "public_account",
  entryWorker: {
    name: "rejot-backoffice",
    environment: {
      variables: ["AUTH_EMAIL_VERIFICATION_ENABLED", "DOCS_PUBLIC_BASE_URL"],
      // Durable Object classes execute in the entry Worker, so their secrets belong here rather
      // than in the route Workers that call them through bindings.
      secrets: {
        required: [
          "AUTH_ACCESS_TOKEN_SECRET",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "GITHUB_APP_ID",
          "GITHUB_APP_SLUG",
          "GITHUB_APP_CLIENT_ID",
          "GITHUB_APP_CLIENT_SECRET",
          "GITHUB_APP_WEBHOOK_SECRET",
          "GITHUB_APP_PRIVATE_KEY",
          "OPENAI_API_KEY",
          "CLOUDFLARE_WORKERS_ACCOUNT_ID",
          "CLOUDFLARE_WORKERS_API_TOKEN",
        ],
        optional: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
      },
    },
  },
  reactRouterWorkers: {
    public_account: {
      name: "rejot-backoffice-routes-public-account",
      serviceBinding: "ROUTES_PUBLIC_ACCOUNT",
      routeModules: [
        "routes/backoffice/auth-bootstrap.tsx",
        "routes/backoffice/device.tsx",
        "routes/backoffice/index.tsx",
        "routes/backoffice/invitation-accept.tsx",
        "routes/backoffice/login.tsx",
        "routes/backoffice/not-found.tsx",
        "routes/backoffice/organization-billing.tsx",
        "routes/backoffice/organization-invites.tsx",
        "routes/backoffice/organization-layout.tsx",
        "routes/backoffice/organization-members.tsx",
        "routes/backoffice/organization-overview.tsx",
        "routes/backoffice/organizations.tsx",
        "routes/backoffice/settings.tsx",
        "routes/backoffice/sign-up.tsx",
        "routes/backoffice/users.tsx",
        "routes/backoffice/verify-email.tsx",
        "routes/forms/form.tsx",
      ],
      routeModulePrefixes: ["routes/landing/"],
      requestPathPrefixes: [],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    sessions: {
      name: "rejot-backoffice-routes-sessions",
      serviceBinding: "ROUTES_SESSIONS",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/sessions/"],
      requestPathPrefixes: ["/backoffice/sessions"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    files: {
      name: "rejot-backoffice-routes-files",
      serviceBinding: "ROUTES_FILES",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/files/"],
      requestPathPrefixes: ["/backoffice/files"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    automations: {
      name: "rejot-backoffice-routes-automations",
      serviceBinding: "ROUTES_AUTOMATIONS",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/automations/"],
      requestPathPrefixes: ["/backoffice/automations"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: ["^/backoffice/automations/[^/]+/[^/]+/integrations/"],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    connections: {
      name: "rejot-backoffice-routes-connections",
      serviceBinding: "ROUTES_CONNECTIONS",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/connections/"],
      requestPathPrefixes: ["/backoffice/connections"],
      requestPathRegularExpressions: ["^/backoffice/automations/[^/]+/[^/]+/integrations/"],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    internals: {
      name: "rejot-backoffice-routes-internals",
      serviceBinding: "ROUTES_INTERNALS",
      routeModules: [
        "routes/backoffice/internals/generated-ui.tsx",
        "routes/backoffice/internals/github.tsx",
        "routes/backoffice/internals/index.tsx",
        "routes/backoffice/internals/redirect.tsx",
        "routes/backoffice/internals/users.tsx",
      ],
      routeModulePrefixes: ["routes/backoffice/internals/workflows"],
      requestPathPrefixes: ["/backoffice/internals"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [
        "^/backoffice/internals/[^/]+/[^/]+/cloudflare(?:/|$)",
        "^/backoffice/internals/[^/]+/[^/]+/durable-hooks(?:/|$)",
      ],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    internals_browser: {
      name: "rejot-backoffice-routes-internals-browser",
      serviceBinding: "ROUTES_INTERNALS_BROWSER",
      routeModules: ["routes/backoffice/internals/cloudflare-browser-run.tsx"],
      routeModulePrefixes: [],
      requestPathPrefixes: [],
      requestPathRegularExpressions: ["^/backoffice/internals/[^/]+/[^/]+/cloudflare(?:/|$)"],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    internals_durable_hooks: {
      name: "rejot-backoffice-routes-internals-durable-hooks",
      serviceBinding: "ROUTES_INTERNALS_DURABLE_HOOKS",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/internals/durable-hooks"],
      requestPathPrefixes: [],
      requestPathRegularExpressions: ["^/backoffice/internals/[^/]+/[^/]+/durable-hooks(?:/|$)"],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    marketplace: {
      name: "rejot-backoffice-routes-marketplace",
      serviceBinding: "ROUTES_MARKETPLACE",
      routeModules: [],
      routeModulePrefixes: ["routes/backoffice/marketplace/"],
      requestPathPrefixes: ["/backoffice/marketplace"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
    api: {
      name: "rejot-backoffice-routes-api",
      serviceBinding: "ROUTES_API",
      routeModules: [
        "routes/api/admin-grant.ts",
        "routes/api/api-oauth-start.ts",
        "routes/api/api.ts",
        "routes/api/auth.ts",
        "routes/api/automations-scoped.ts",
        "routes/api/backoffice-cli-config.ts",
        "routes/api/backoffice-cli-token.ts",
        "routes/api/backoffice-me.ts",
        "routes/api/cloudflare.ts",
        "routes/api/files-scoped-workspace.ts",
        "routes/api/forms.ts",
        "routes/api/github-webhooks.ts",
        "routes/api/github.ts",
        "routes/api/marketplace.ts",
        "routes/api/mcp-oauth-start.ts",
        "routes/api/mcp.ts",
        "routes/api/otp.ts",
        "routes/api/pi.ts",
        "routes/api/resend.ts",
        "routes/api/reson8.ts",
        "routes/api/telegram.ts",
        "routes/api/upload-scoped.ts",
        "routes/api/upload.ts",
        "routes/api/workflows.ts",
      ],
      routeModulePrefixes: [],
      requestPathPrefixes: ["/api"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: ["/api/backoffice/codemode"],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        // These are read directly by API route modules instead of by entry-hosted Durable Objects.
        secrets: {
          required: ["AUTH_ADMIN_GRANT_TOKEN", "GITHUB_APP_WEBHOOK_SECRET"],
          optional: [],
        },
      },
    },
    development_tools: {
      name: "rejot-backoffice-routes-development-tools",
      serviceBinding: "ROUTES_DEVELOPMENT_TOOLS",
      routeModules: [
        "routes/api/backoffice-codemode-bash.ts",
        "routes/api/backoffice-codemode-system-md.ts",
        "routes/api/backoffice-codemode.ts",
      ],
      routeModulePrefixes: [],
      requestPathPrefixes: ["/api/backoffice/codemode"],
      requestPathRegularExpressions: [],
      excludedRequestPathPrefixes: [],
      excludedRequestPathRegularExpressions: [],
      environment: {
        variables: sharedReactRouterVariables,
        secrets: { required: [], optional: [] },
      },
    },
  },
} as const satisfies BackofficeWorkerTopology;

export type BackofficeReactRouterWorkerId =
  keyof typeof BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers;

export type BackofficeReactRouterWorker =
  (typeof BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers)[BackofficeReactRouterWorkerId];

export type BackofficeRouteServiceBinding = BackofficeReactRouterWorker["serviceBinding"];
