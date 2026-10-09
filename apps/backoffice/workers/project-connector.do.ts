import {
  backofficeUserScopeSchema,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { ProjectConnectorFragmentConfig } from "@fragno-dev/project-connector-fragment/definition";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type ProjectConnectorObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createProjectConnectorServer,
  type ProjectConnectorFragment,
} from "@/fragno/project-connector";
import {
  isScopedPublicOAuthRedirectUriAllowed,
  PROJECT_CONNECTOR_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type ProjectConnectorObjectEnv = Pick<
  BackofficeRuntimeEnv,
  | "OOMOL_CONNECTOR_BASE_URL"
  | "OOMOL_PROJECT_API_KEY"
  | "OOMOL_CONNECTOR_CATALOG_API_KEY"
  | "BACKOFFICE_INTERNAL_REQUEST_SECRET"
>;
type ConfiguredProjectConnectorObject = {
  host: FragmentDurableObjectHost<ProjectConnectorFragmentConfig, ProjectConnectorFragment>;
  scopedRuntime: ScopedFragmentDurableObjectRuntime<ProjectConnectorFragment>;
};

/** Isolates provider bindings by the authoritative user, organization, or project object identity. */
export class InMemoryProjectConnectorObject extends RpcTarget implements ProjectConnectorObject {
  readonly #configured: ConfiguredProjectConnectorObject | null;
  readonly #forwardHttpRequest: ReturnType<typeof createBackofficeFragmentHttpTransport>;

  constructor({
    state,
    env,
    nowEpochMs,
    runtime,
    implementation,
  }: {
    state: BackofficeObjectState;
    env: ProjectConnectorObjectEnv;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    this.#forwardHttpRequest = createBackofficeFragmentHttpTransport({
      address: {
        binding: "PROJECT_CONNECTOR",
        scope: backofficeObjectScopeFromContextScope(
          requireBackofficeContextScopeFromDurableObjectId(state.id, "PROJECT_CONNECTOR"),
        ),
      },
      env,
      nowEpochMs,
    });
    const baseUrl = env.OOMOL_CONNECTOR_BASE_URL?.trim();
    const apiKey = env.OOMOL_PROJECT_API_KEY?.trim();
    if (!baseUrl || !apiKey) {
      this.#configured = null;
      return;
    }
    const host: FragmentDurableObjectHost<
      ProjectConnectorFragmentConfig,
      ProjectConnectorFragment
    > = implementation.createFragmentHost({
      name: "Connector",
      createRuntime: (config) =>
        createProjectConnectorServer(
          config,
          implementation.fragmentDatabase,
          new BackofficeKernel(runtime),
        ),
      onProcessError: (error) => {
        console.error("Connector hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Connector hook dispatcher initialization failed", error);
      },
    });
    const scopedRuntime = createScopedFragmentDurableObjectRuntime({
      name: "Connector",
      state,
      ownerScope: backofficeContextScopeFromDurableObjectId(state.id, "PROJECT_CONNECTOR"),
      host,
      scopeSchema: backofficeUserScopeSchema,
      createSource: function createScopedProjectConnectorConfig(
        scope,
      ): ProjectConnectorFragmentConfig {
        // Provider accounts are user-owned. Use the ID-backed user scope upstream; caller-supplied
        // identities and organization slugs are not authoritative account owners.
        const externalUserId = backofficeScopePathSegment(scope);
        return {
          baseUrl,
          apiKey,
          catalogApiKey: env.OOMOL_CONNECTOR_CATALOG_API_KEY?.trim() || null,
          getExternalUserId: () => externalUserId,
          allowedReturnUrls: (redirectUri) =>
            isScopedPublicOAuthRedirectUriAllowed({
              publicOrigin: runtime.config.docsPublicBaseUrl,
              publicPrefix: PROJECT_CONNECTOR_PUBLIC_PREFIX,
              redirectUri,
            }),
        };
      },
    });
    this.#configured = { host, scopedRuntime };
    void state.blockConcurrencyWhile(async () => {
      await scopedRuntime.initializeFromOwnerScope();
    });
  }

  async alarm(): Promise<void> {
    if (this.#configured) {
      await this.#configured.scopedRuntime.alarm();
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#configured) {
      return Response.json(
        { code: "NOT_CONFIGURED", message: "Connector is not configured." },
        { status: 400 },
      );
    }
    const { host, scopedRuntime } = this.#configured;
    return await this.#forwardHttpRequest(request, async (verifiedRequest, options) =>
      host.fetch(await scopedRuntime.getRuntime(), verifiedRequest, options),
    );
  }
}

/** Cloudflare and Node use the same user-owned Connector host and migrations. */
export class ProjectConnectorDurableObject
  extends DurableObject<CloudflareEnv>
  implements ProjectConnectorObject
{
  readonly #object: InMemoryProjectConnectorObject;
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryProjectConnectorObject(
      createCloudflareBackofficeObjectContext(state, env),
    );
  }
  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
