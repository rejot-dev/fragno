import Cloudflare, {
  NotFoundError,
  toFile,
  type ClientOptions as CloudflareClientOptions,
} from "cloudflare";
import type {
  ScriptUpdateParams,
  ScriptUpdateResponse,
} from "cloudflare/resources/workers-for-platforms/dispatch/namespaces/scripts/scripts";

import {
  buildCloudflareAppTag,
  buildCloudflareDeploymentTag,
  findCloudflareDeploymentTag,
  getCloudflareDeploymentIdFromTag,
  sanitizeCloudflareTag,
} from "./deployment-tag";

export type CloudflareDispatchNamespaceBinding = {
  get(name: string, args?: Record<string, unknown>, options?: unknown): unknown;
};

export type CloudflareDispatchNamespaceDescriptor = {
  binding: CloudflareDispatchNamespaceBinding;
  namespace: string;
};

export type CloudflareDispatcherConfig = string | CloudflareDispatchNamespaceDescriptor;

type CloudflareApiClientConfig = {
  apiToken: string;
  fetchImplementation?: CloudflareClientOptions["fetch"];
  maxRetries?: number;
};

export type CloudflareApiClient = Cloudflare;
export type CloudflareScriptUpdateParams = ScriptUpdateParams;
export type CloudflareScriptUpdateResponse = ScriptUpdateResponse;

export type DeployCloudflareWorkerInput = {
  accountId: string;
  dispatchNamespace: string;
  scriptName: string;
  entrypoint: string;
  moduleContent: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  tags?: string[];
  ifMatch?: string | null;
};

export type ReconcileCloudflareWorkerDeploymentInput = {
  accountId: string;
  dispatchNamespace: string;
  appId: string;
  deploymentId: string;
  expectedLiveEtag: string | null;
  deploymentTagPrefix?: string;
  scriptName: string;
  entrypoint: string;
  moduleContent: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  scriptTags?: string[];
};

export type CloudflareDeploymentReconciliationResult =
  | {
      action: "already-deployed";
      deploymentTag: string;
      currentDeploymentTag: string;
      currentDeploymentId: string | null;
      currentEtag: string | null;
      currentModifiedOn: string | null;
    }
  | {
      action: "uploaded";
      deploymentTag: string;
      response: CloudflareScriptUpdateResponse;
    }
  | {
      action: "superseded";
      deploymentTag: string;
      currentDeploymentTag: string;
      currentDeploymentId: string | null;
      currentEtag: string | null;
      currentModifiedOn: string | null;
    };

export type CloudflareCurrentDeployment = {
  deploymentTag: string;
  deploymentId: string | null;
} | null;

export type CloudflareScriptState = {
  etag: string | null;
  modifiedOn: string | null;
} | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readNamespaceCandidate = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const unique = <T>(items: T[]) => {
  return Array.from(new Set(items));
};

const hasBindingDescriptor = (
  value: CloudflareDispatcherConfig,
): value is CloudflareDispatchNamespaceDescriptor => {
  return typeof value === "object" && value !== null && "binding" in value;
};

export const resolveCloudflareDispatchNamespaceName = (dispatcher: CloudflareDispatcherConfig) => {
  if (typeof dispatcher === "string") {
    const namespace = readNamespaceCandidate(dispatcher);
    if (namespace) {
      return namespace;
    }
  } else if (hasBindingDescriptor(dispatcher)) {
    const namespace = readNamespaceCandidate(dispatcher.namespace);
    if (namespace) {
      return namespace;
    }
  }

  throw new Error(
    'Cloudflare fragment requires a dispatch namespace name. Pass `dispatcher: "my-namespace"` or `dispatcher: { binding: env.DISPATCHER, namespace: "my-namespace" }`.',
  );
};

export const buildCloudflareScriptTags = (
  dynamicTags: string | string[],
  staticTags: string[] = [],
) => {
  const normalizedDynamicTags = Array.isArray(dynamicTags) ? dynamicTags : [dynamicTags];

  return unique(
    [...staticTags, ...normalizedDynamicTags]
      .map(sanitizeCloudflareTag)
      .filter((tag) => tag.length > 0),
  );
};

export const createCloudflareApiClient = ({
  apiToken,
  fetchImplementation,
  maxRetries = 0,
}: CloudflareApiClientConfig): CloudflareApiClient => {
  return new Cloudflare({
    apiToken,
    fetch: fetchImplementation,
    maxRetries,
  });
};

export const listCloudflareScriptTags = async (
  client: CloudflareApiClient,
  input: {
    accountId: string;
    dispatchNamespace: string;
    scriptName: string;
  },
) => {
  try {
    const tags = await client.workersForPlatforms.dispatch.namespaces.scripts.tags.list(
      input.dispatchNamespace,
      input.scriptName,
      {
        account_id: input.accountId,
      },
    );
    const results: string[] = [];

    for await (const tag of tags) {
      results.push(tag);
    }

    return results;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return [];
    }

    throw error;
  }
};

export const getCloudflareCurrentDeployment = async (
  client: CloudflareApiClient,
  input: {
    accountId: string;
    dispatchNamespace: string;
    scriptName: string;
    deploymentTagPrefix?: string;
  },
): Promise<CloudflareCurrentDeployment> => {
  const remoteTags = await listCloudflareScriptTags(client, input);
  const deploymentTag = findCloudflareDeploymentTag(remoteTags, input.deploymentTagPrefix);

  if (deploymentTag === null) {
    return null;
  }

  return {
    deploymentTag,
    deploymentId: getCloudflareDeploymentIdFromTag(deploymentTag, input.deploymentTagPrefix),
  };
};

export const getCloudflareScriptState = async (
  client: CloudflareApiClient,
  input: {
    accountId: string;
    dispatchNamespace: string;
    scriptName: string;
  },
): Promise<CloudflareScriptState> => {
  try {
    const script = await client.workersForPlatforms.dispatch.namespaces.scripts.get(
      input.dispatchNamespace,
      input.scriptName,
      {
        account_id: input.accountId,
      },
    );

    return {
      etag: script.script?.etag ?? null,
      modifiedOn: script.modified_on ?? null,
    };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }

    throw error;
  }
};

export const deployCloudflareWorker = async (
  client: CloudflareApiClient,
  input: DeployCloudflareWorkerInput,
) => {
  const moduleFile = await toFile(new TextEncoder().encode(input.moduleContent), input.entrypoint, {
    type: "application/javascript+module",
  });
  const params: CloudflareScriptUpdateParams = {
    account_id: input.accountId,
    metadata: {
      main_module: input.entrypoint,
      compatibility_date: input.compatibilityDate,
      compatibility_flags:
        input.compatibilityFlags.length > 0 ? input.compatibilityFlags : undefined,
      tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    },
    files: [moduleFile],
  };

  return await client.workersForPlatforms.dispatch.namespaces.scripts.update(
    input.dispatchNamespace,
    input.scriptName,
    params,
    input.ifMatch
      ? {
          headers: {
            "If-Match": input.ifMatch,
          },
        }
      : undefined,
  );
};

export const reconcileCloudflareWorkerDeployment = async (
  client: CloudflareApiClient,
  input: ReconcileCloudflareWorkerDeploymentInput,
): Promise<CloudflareDeploymentReconciliationResult> => {
  const appTag = buildCloudflareAppTag(input.appId, input.deploymentTagPrefix);
  const deploymentTag = buildCloudflareDeploymentTag(input.deploymentId, input.deploymentTagPrefix);
  try {
    const response = await deployCloudflareWorker(client, {
      accountId: input.accountId,
      dispatchNamespace: input.dispatchNamespace,
      scriptName: input.scriptName,
      entrypoint: input.entrypoint,
      moduleContent: input.moduleContent,
      compatibilityDate: input.compatibilityDate,
      compatibilityFlags: input.compatibilityFlags,
      tags: buildCloudflareScriptTags([appTag, deploymentTag], input.scriptTags),
      ifMatch: input.expectedLiveEtag,
    });

    return {
      action: "uploaded",
      deploymentTag,
      response,
    };
  } catch (error) {
    const cloudflareError = getCloudflareApiError(error);
    if (cloudflareError?.status !== 412) {
      throw error;
    }

    const [currentDeployment, scriptState] = await Promise.all([
      getCloudflareCurrentDeployment(client, {
        accountId: input.accountId,
        dispatchNamespace: input.dispatchNamespace,
        scriptName: input.scriptName,
        deploymentTagPrefix: input.deploymentTagPrefix,
      }),
      getCloudflareScriptState(client, {
        accountId: input.accountId,
        dispatchNamespace: input.dispatchNamespace,
        scriptName: input.scriptName,
      }),
    ]);

    if (currentDeployment?.deploymentTag === deploymentTag) {
      return {
        action: "already-deployed",
        deploymentTag,
        currentDeploymentTag: currentDeployment.deploymentTag,
        currentDeploymentId: currentDeployment.deploymentId,
        currentEtag: scriptState?.etag ?? null,
        currentModifiedOn: scriptState?.modifiedOn ?? null,
      };
    }

    if (currentDeployment !== null) {
      return {
        action: "superseded",
        deploymentTag,
        currentDeploymentTag: currentDeployment.deploymentTag,
        currentDeploymentId: currentDeployment.deploymentId,
        currentEtag: scriptState?.etag ?? null,
        currentModifiedOn: scriptState?.modifiedOn ?? null,
      };
    }

    throw error;
  }
};

export const getCloudflareApiError = (error: unknown) => {
  if (!(error instanceof Cloudflare.APIError)) {
    return null;
  }

  const [firstError] = error.errors;
  return {
    status: error.status,
    code:
      firstError?.code === undefined || firstError?.code === null
        ? error.name
        : String(firstError.code),
    message: firstError?.message ?? error.message,
    details: isRecord(error.error) ? error.error : undefined,
  };
};
