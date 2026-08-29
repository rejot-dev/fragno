import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "./internal-object-request";
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
};

const getNamespace = (
  env: CloudflareEnv,
  binding: BackofficeObjectBinding<unknown>,
): DurableObjectNamespaceLike => {
  const namespace = env[binding.name as keyof CloudflareEnv];
  if (!namespace || typeof namespace !== "object") {
    throw new Error(`Backoffice Durable Object binding ${binding.name} is not configured.`);
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
    const namespace = getNamespace(this.env, binding);
    const encodedName = encodeBackofficeObjectAddress(address);
    const id = namespace.idFromName(encodedName);
    const stub = namespace.get(id) as TCommands & {
      fetch(request: Request): Promise<Response>;
    };
    const http: BackofficeObjectHttp & { readonly id: DurableObjectId } = {
      // Preserve the target identity so isolate-local caches survive newly assembled object handles.
      id,
      fetch: async (request) =>
        forwardRequestOwnedResponse(
          request,
          await stub.fetch(removeBackofficeInternalContextHeader(request)),
        ),
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
}

export const createCloudflareBackofficeObjectRegistry = (
  env: CloudflareEnv,
): BackofficeObjectRegistry =>
  createBackofficeObjectRegistry(new CloudflareDurableObjectFactory(env));
