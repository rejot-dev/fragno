import {
  type BackofficeJurisdiction,
  backofficeScopeJurisdiction,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { piAgentObjectName, type PiAgentAddress } from "@/fragno/pi/agent/pi-agent-contract";

import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "./internal-object-request";
import { BackofficeUnavailableError } from "./kernel";
import type {
  BackofficeObjectAddress,
  BackofficeObjectBinding,
  BackofficeObjectFactory,
  BackofficeObjectHandle,
  BackofficeObjectHttp,
} from "./object-registry";
import { createBackofficeObjectRegistry } from "./object-registry";
import { assertBackofficeObjectAddressAllowed } from "./object-registry";
import { encodeBackofficeObjectAddress } from "./object-registry";
import type { BackofficeObjectRegistry } from "./object-registry";
import { forwardRequestOwnedResponse } from "./request-owned-response";

type DurableObjectNamespaceLike = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): unknown;
  jurisdiction(jurisdiction: BackofficeJurisdiction): DurableObjectNamespaceLike;
};

type JurisdictionEnv = Pick<CloudflareEnv, "DURABLE_OBJECT_JURISDICTIONS">;

/**
 * Where an owner's objects are kept: the namespace restricted to its jurisdiction, as Cloudflare
 * recommends, or the whole namespace when it has none. The same name is another object in each.
 * workerd does not implement jurisdictions, so local development says "local" to ignore them; any
 * other setting enforces them, and a misconfigured deployment fails rather than keeping objects
 * outside their jurisdiction. Names carry the jurisdiction, so objects stay apart locally too.
 */
export function jurisdictionNamespace<TNamespace extends DurableObjectNamespaceLike>(
  env: JurisdictionEnv,
  namespace: TNamespace,
  jurisdiction: BackofficeJurisdiction | null,
): TNamespace {
  return jurisdiction === null || env.DURABLE_OBJECT_JURISDICTIONS === "local"
    ? namespace
    : (namespace.jurisdiction(jurisdiction) as TNamespace);
}

/** The ID of a Pi agent's object, kept in its scope's jurisdiction. */
export function piAgentDurableObjectId(
  env: JurisdictionEnv & Pick<CloudflareEnv, "PI">,
  agent: PiAgentAddress,
): DurableObjectId {
  return jurisdictionNamespace(env, env.PI, backofficeScopeJurisdiction(agent.scope)).idFromName(
    piAgentObjectName(agent),
  );
}

/** The jurisdiction an address's object is kept in on Cloudflare. */
export function objectAddressJurisdiction({ scope }: BackofficeObjectAddress) {
  return scope.kind === "singleton" || scope.kind === "named"
    ? null
    : backofficeScopeJurisdiction(scope);
}

const getNamespace = (
  env: CloudflareEnv,
  binding: BackofficeObjectBinding<unknown>,
): DurableObjectNamespaceLike => {
  const namespace = env[binding.name as keyof CloudflareEnv];
  if (!namespace || typeof namespace !== "object") {
    throw new BackofficeUnavailableError(
      `Backoffice Durable Object binding ${binding.name} is not configured.`,
    );
  }

  return namespace as DurableObjectNamespaceLike;
};

export class CloudflareDurableObjectFactory implements BackofficeObjectFactory {
  constructor(readonly env: CloudflareEnv) {}

  get<TCommands>(
    binding: BackofficeObjectBinding<TCommands>,
    address: BackofficeObjectAddress,
  ): BackofficeObjectHandle<TCommands> {
    if (address.binding !== binding.name) {
      throw new Error(
        `Backoffice object address binding ${address.binding} does not match requested binding ${binding.name}.`,
      );
    }
    assertBackofficeObjectAddressAllowed(address);
    const namespace = jurisdictionNamespace(
      this.env,
      getNamespace(this.env, binding),
      objectAddressJurisdiction(address),
    );
    const encodedName = encodeBackofficeObjectAddress(address);
    const id = namespace.idFromName(encodedName);
    const stub = namespace.get(id) as TCommands & {
      fetch(request: Request): Promise<Response>;
    };
    const http: BackofficeObjectHttp & { readonly id: DurableObjectId } = {
      // Preserve the target identity so isolate-local caches survive newly assembled object handles.
      id,
      fetch: async (request, options) => {
        const response = await stub.fetch(removeBackofficeInternalContextHeader(request));
        return options?.passThrough ? response : forwardRequestOwnedResponse(request, response);
      },
      fetchAuthorized: async (request, context) =>
        forwardRequestOwnedResponse(
          request,
          await stub.fetch(
            await createAuthorizedBackofficeObjectRequest({
              request,
              address,
              context: {
                execution: context.execution,
                propagationContext: context.propagationContext ?? null,
              },
              env: this.env,
            }),
          ),
        ),
    };
    return { commands: stub, http };
  }

  piAgent(agent: PiAgentAddress): Pick<BackofficeObjectHttp, "fetchAuthorized"> {
    const stub = this.env.PI.get(piAgentDurableObjectId(this.env, agent));
    return {
      fetchAuthorized: async (request, context) =>
        forwardRequestOwnedResponse(
          request,
          await stub.fetch(
            await createAuthorizedBackofficeObjectRequest({
              request,
              address: { binding: "PI", agent },
              context: {
                execution: context.execution,
                propagationContext: context.propagationContext ?? null,
              },
              env: this.env,
            }),
          ),
        ),
    };
  }
}

export const createCloudflareBackofficeObjectRegistry = (
  env: CloudflareEnv,
): BackofficeObjectRegistry =>
  createBackofficeObjectRegistry(new CloudflareDurableObjectFactory(env));
