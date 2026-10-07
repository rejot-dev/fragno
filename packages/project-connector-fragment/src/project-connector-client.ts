import { z } from "zod";

import {
  Connector,
  ConnectorError,
  ProjectConnector,
  type ProjectApi,
  type ProjectCallOptions,
  type ProjectConnectorConfig,
} from "@oomol-lab/connector";

import {
  projectConnectorActionSchema,
  projectConnectorConnectionStateSchema,
  type projectConnectorConnectInputSchema,
  projectConnectorExecutionSchema,
  projectConnectorHttpUrlSchema,
  projectConnectorProfileSchema,
  projectConnectorProviderConfigsSchema,
  type ProjectConnectorConnectionState,
} from "./project-connector-contracts";

const projectConnectorConnectionRequestSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    providerConfigId: z.string().min(1),
    externalUserId: z.string().min(1),
    service: z.string().min(1),
    connectionName: z.string().nullable(),
    authorizationUrl: projectConnectorHttpUrlSchema,
    expiresAt: z.string(),
  })
  .and(projectConnectorConnectionStateSchema);

const projectConnectorCallOptions = { retries: 0 } satisfies ProjectCallOptions;
const projectConnectorDiscoveryEnvelopeSchema = z.object({
  success: z.literal(true),
  data: projectConnectorProviderConfigsSchema.safeExtend({
    providerConfigs: z.array(
      projectConnectorProviderConfigsSchema.shape.providerConfigs.element.extend({
        actionIds: z.array(z.string().min(1)),
      }),
    ),
  }),
});

const projectConnectorCatalogActionSchema = projectConnectorActionSchema.extend({
  description: z
    .string()
    .nullish()
    .transform((description) => description ?? null),
});

type ProjectConnectorSdk = Pick<
  ProjectApi,
  "getConnectionRequest" | "getUserProfile" | "executeRaw"
> & {
  readonly connect: Pick<ProjectApi["connect"], "oauth">;
};

type CreateProjectConnectorSdk = (config: ProjectConnectorConfig) => ProjectConnectorSdk;

function createOomolProjectConnectorSdk(config: ProjectConnectorConfig): ProjectConnectorSdk {
  return new ProjectConnector({
    ...config,
    // The wrapper also avoids the SDK calling native Workers fetch with a transport receiver.
    fetch: fetchProjectConnectorWithoutRedirects,
  });
}

/** A safe SDK failure exposes its code, never its raw response data or project API key. */
export class ProjectConnectorClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Project Connector request failed: ${code} (HTTP ${status})`);
    this.name = "ProjectConnectorClientError";
  }
}

/** Server-only gateway credentials; null catalogApiKey disables action discovery, not account operations. */
export type ProjectConnectorClientConfig = {
  baseUrl: string;
  apiKey: string;
  catalogApiKey: string | null;
};

function parseProjectConnectorApiBaseUrl(value: string): string {
  const baseUrl = new URL(projectConnectorHttpUrlSchema.parse(value));
  const pathname = baseUrl.pathname.replace(/\/+$/, "");
  if (baseUrl.search || baseUrl.hash || pathname !== "/v1") {
    throw new Error("Project Connector baseUrl must be an origin followed by /v1");
  }
  baseUrl.pathname = pathname;
  return baseUrl.toString().replace(/\/$/, "");
}

function parseProjectConnectorApiKey(value: string): string {
  return z
    .string()
    .min(1)
    .regex(/^[^\s]+$/)
    .parse(value);
}

function projectConnectorClientErrorFromKnownFailure(
  error: unknown,
): ProjectConnectorClientError | null {
  if (error instanceof ProjectConnectorClientError) {
    return error;
  }
  if (error instanceof ConnectorError) {
    // The SDK wraps transport rejections as network errors; retain our safe redirect diagnosis.
    if (error.cause instanceof ProjectConnectorClientError) {
      return error.cause;
    }
    // Callers only see the code; the gateway's message (e.g. which input field it rejected) stays in
    // server logs. Gateway messages never contain the project API key.
    console.warn("Project Connector gateway request failed", {
      code: error.code,
      status: error.status,
      message: error.message,
      requestId: error.requestId,
    });
    return new ProjectConnectorClientError(error.code, error.status);
  }
  return null;
}

async function callProjectConnector<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const knownFailure = projectConnectorClientErrorFromKnownFailure(error);
    if (knownFailure) {
      throw knownFailure;
    }
    throw error;
  }
}

function parseProjectConnectorResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectConnectorClientError("invalid_response", 502);
  }
  return parsed.data;
}

async function fetchProjectConnectorWithoutRedirects(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  // Workers rejects redirect: "error" before sending the request. Manual mode keeps credentials
  // on the original host; reject redirects before interpreting the response body.
  const response = await globalThis.fetch(input, { ...init, redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    throw new ProjectConnectorClientError("unexpected_redirect", response.status);
  }
  return response;
}

async function fetchProjectConnectorProviderConfigs(
  config: Pick<ProjectConnectorClientConfig, "baseUrl" | "apiKey">,
) {
  // The SDK has no discovery method; redirects must not forward the project key elsewhere.
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetchProjectConnectorWithoutRedirects(
      `${config.baseUrl}/saas/oauth/provider-configs`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal,
      },
    );
  } catch (cause) {
    if (signal.aborted) {
      throw new ProjectConnectorClientError("client_timeout", 0);
    }
    if (cause instanceof TypeError) {
      throw new ProjectConnectorClientError("client_network_error", 0);
    }
    throw cause;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (signal.aborted) {
      throw new ProjectConnectorClientError("client_timeout", 0);
    }
    if (cause instanceof TypeError) {
      throw new ProjectConnectorClientError("client_network_error", 0);
    }
    if (!(cause instanceof SyntaxError)) {
      throw cause;
    }
    payload = null;
  }
  const failure = z.object({ errorCode: z.string().min(1) }).safeParse(payload);
  if (!response.ok || failure.success) {
    throw new ProjectConnectorClientError(
      failure.success
        ? failure.data.errorCode
        : response.status === 429
          ? "rate_limited"
          : "provider_error",
      response.status,
    );
  }
  return parseProjectConnectorResponse(projectConnectorDiscoveryEnvelopeSchema, payload).data;
}

/** Project Connector adapter with retries disabled and project keys confined to server requests. */
export function createProjectConnectorClient(
  config: ProjectConnectorClientConfig,
  createSdk: CreateProjectConnectorSdk = createOomolProjectConnectorSdk,
) {
  const apiKey = parseProjectConnectorApiKey(config.apiKey);
  const baseUrl = parseProjectConnectorApiBaseUrl(config.baseUrl);
  const client = createSdk({ apiKey, baseUrl, maxRetries: 0 });
  // Project credentials and catalog credentials have different authority; never substitute one for the other.
  const catalog =
    config.catalogApiKey === null
      ? null
      : new Connector({
          apiKey: parseProjectConnectorApiKey(config.catalogApiKey),
          baseUrl,
          maxRetries: 0,
          fetch: fetchProjectConnectorWithoutRedirects,
        }).catalog;

  return {
    async listProviderConfigs() {
      const discovery = await fetchProjectConnectorProviderConfigs({ apiKey, baseUrl });
      return {
        projectId: discovery.projectId,
        providerConfigs: discovery.providerConfigs.map((config) => ({
          id: config.id,
          service: config.service,
          displayName: config.displayName,
          callbackUrl: config.callbackUrl,
          effectiveScopes: config.effectiveScopes,
          proxyAvailable: config.proxyAvailable,
        })),
      };
    },
    async listProviderActions(providerConfigId: string) {
      const discovery = await fetchProjectConnectorProviderConfigs({ apiKey, baseUrl });
      const config = discovery.providerConfigs.find((config) => config.id === providerConfigId);
      if (!config) {
        return null;
      }
      const actions: z.output<typeof projectConnectorActionSchema>[] = [];
      if (config.actionIds.length > 0) {
        if (!catalog) {
          throw new ProjectConnectorClientError("catalog_not_configured", 503);
        }
        const serviceActions = parseProjectConnectorResponse(
          z
            .array(projectConnectorCatalogActionSchema)
            .refine(
              (actions) => new Set(actions.map((action) => action.id)).size === actions.length,
              "Catalog action IDs must be unique",
            ),
          await callProjectConnector(() =>
            catalog.actions(config.service, projectConnectorCallOptions),
          ),
        );
        const actionsById = new Map(serviceActions.map((action) => [action.id, action]));
        // Fetching the service catalog never expands this configuration's allowlist.
        for (const actionId of new Set(config.actionIds)) {
          const action = actionsById.get(actionId);
          if (!action) {
            throw new ProjectConnectorClientError("action_not_found", 502);
          }
          if (action.service !== config.service) {
            throw new ProjectConnectorClientError("action_identity_mismatch", 502);
          }
          actions.push(action);
        }
      }
      return {
        projectId: discovery.projectId,
        providerConfigId: config.id,
        actions,
      };
    },
    async check() {
      // The project API has no health endpoint. An authenticated lookup of a fresh,
      // nonexistent request must return connection_request_not_found, not Unauthorized.
      try {
        await client.getConnectionRequest(
          `fragno-check-${crypto.randomUUID()}`,
          projectConnectorCallOptions,
        );
      } catch (error) {
        const knownFailure = projectConnectorClientErrorFromKnownFailure(error);
        if (knownFailure?.status === 404 && knownFailure.code === "connection_request_not_found") {
          return { authenticated: true as const };
        }
        if (knownFailure) {
          throw knownFailure;
        }
        throw error;
      }
      throw new ProjectConnectorClientError("unexpected_health_response", 502);
    },
    async connect(
      externalUserId: string,
      input: z.infer<typeof projectConnectorConnectInputSchema>,
    ) {
      const request = await callProjectConnector(() =>
        client.connect.oauth(
          externalUserId,
          {
            ...("providerConfigId" in input
              ? { providerConfigId: input.providerConfigId }
              : { service: input.service }),
            connectionName: input.connectionName,
            returnUri: input.returnUri,
          },
          projectConnectorCallOptions,
        ),
      );
      return parseProjectConnectorResponse(projectConnectorConnectionRequestSchema, request);
    },
    async getConnectionRequest(requestId: string) {
      const request = await callProjectConnector(() =>
        client.getConnectionRequest(requestId, projectConnectorCallOptions),
      );
      return parseProjectConnectorResponse(projectConnectorConnectionRequestSchema, request);
    },
    async getProfile(accountId: string) {
      const profile = await callProjectConnector(() =>
        client.getUserProfile(accountId, projectConnectorCallOptions),
      );
      return parseProjectConnectorResponse(projectConnectorProfileSchema, profile);
    },
    async execute(
      account: { externalUserId: string; providerConfigId: string; id: string },
      actionId: string,
      input: Record<string, unknown>,
    ) {
      const result = await callProjectConnector(() =>
        client.executeRaw(account.externalUserId, actionId, input, {
          providerConfigId: account.providerConfigId,
          connectedAccountId: account.id,
          retries: 0,
        }),
      );
      return parseProjectConnectorResponse(projectConnectorExecutionSchema, {
        executionId: result.executionId,
        actionId: result.actionId,
        output: result.data,
      });
    },
  };
}

/** Pins the SDK response to the saved project, provider, user, and request identity. */
export function confirmProjectConnectorRequest(
  expected: {
    id: string;
    projectId: string;
    providerConfigId: string;
    externalUserId: string;
    service: string;
    connectionName: string | null;
  },
  actual: Awaited<
    ReturnType<ReturnType<typeof createProjectConnectorClient>["getConnectionRequest"]>
  >,
): ProjectConnectorConnectionState {
  if (
    actual.id !== expected.id ||
    actual.projectId !== expected.projectId ||
    actual.providerConfigId !== expected.providerConfigId ||
    actual.externalUserId !== expected.externalUserId ||
    actual.service !== expected.service ||
    actual.connectionName !== expected.connectionName
  ) {
    throw new ProjectConnectorClientError("connection_identity_mismatch", 502);
  }
  if (actual.status === "initiated" || actual.status === "expired") {
    return { status: actual.status };
  }
  if (actual.status === "connected") {
    return { status: "connected", connectedAccountId: actual.connectedAccountId };
  }
  return { status: "failed", errorCode: actual.errorCode, errorMessage: actual.errorMessage };
}
