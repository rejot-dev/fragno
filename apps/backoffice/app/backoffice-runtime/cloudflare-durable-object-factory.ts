import type {
  BackofficeObjectAddress,
  BackofficeObjectBinding,
  BackofficeObjectFactory,
} from "./object-registry";
import { createBackofficeObjectRegistry } from "./object-registry";
import { encodeBackofficeObjectAddress } from "./object-registry";
import type { BackofficeObjectRegistry } from "./object-registry";
import { assertBackofficeObjectAddressAllowed } from "./object-scope-policy";

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

  get<TObject>(
    binding: BackofficeObjectBinding<TObject>,
    address: BackofficeObjectAddress,
  ): TObject {
    if (address.binding !== binding.name) {
      throw new Error(
        `Backoffice object address binding ${address.binding} does not match requested binding ${binding.name}.`,
      );
    }
    assertBackofficeObjectAddressAllowed(address);
    const namespace = getNamespace(this.env, binding);
    const encodedName = encodeBackofficeObjectAddress(address);
    return namespace.get(namespace.idFromName(encodedName)) as TObject;
  }
}

export const createCloudflareBackofficeObjectRegistry = (
  env: CloudflareEnv,
): BackofficeObjectRegistry =>
  createBackofficeObjectRegistry(new CloudflareDurableObjectFactory(env));
