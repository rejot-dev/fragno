import type { BackofficeObjectBinding, BackofficeObjectFactory } from "./object-registry";
import { createBackofficeObjectRegistry } from "./object-registry";
import type { BackofficeObjectRegistry } from "./object-registry";

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

  singleton<TObject>(binding: BackofficeObjectBinding<TObject>, name: string): TObject {
    return this.named(binding, name);
  }

  org<TObject>(binding: BackofficeObjectBinding<TObject>, orgId: string): TObject {
    return this.named(binding, orgId);
  }

  named<TObject>(binding: BackofficeObjectBinding<TObject>, name: string): TObject {
    const namespace = getNamespace(this.env, binding);
    return namespace.get(namespace.idFromName(name)) as TObject;
  }
}

export const createCloudflareBackofficeObjectRegistry = (
  env: CloudflareEnv,
): BackofficeObjectRegistry =>
  createBackofficeObjectRegistry(new CloudflareDurableObjectFactory(env));
