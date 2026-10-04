import { z } from "zod";

import {
  ConnectorError,
  ProjectConnector,
  type ProjectApi,
  type ProjectCallOptions,
  type ProjectConnectorConfig,
} from "@oomol-lab/connector";

import {
  projectConnectorConnectionStateSchema,
  type projectConnectorConnectInputSchema,
  projectConnectorExecutionSchema,
  projectConnectorHttpUrlSchema,
  projectConnectorProfileSchema,
  projectConnectorProviderActionsSchema,
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
        actionIds: projectConnectorProviderActionsSchema.shape.actionIds,
      }),
    ),
  }),
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
    // The SDK calls fetch as a transport method; Workers rejects that native fetch binding.
    fetch: (input, init) => globalThis.fetch(input, init),
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

/** Server-only OOMOL Project Connector configuration; baseUrl includes the `/v1` API root. */
export type ProjectConnectorClientConfig = { baseUrl: string; apiKey: string };

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

async function fetchProjectConnectorProviderConfigs(config: ProjectConnectorClientConfig) {
  // The SDK has no discovery method; redirects must not forward the project key elsewhere.
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/saas/oauth/provider-configs`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      redirect: "error",
      signal,
    });
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
      return {
        projectId: discovery.projectId,
        providerConfigId: config.id,
        actionIds: config.actionIds,
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
