import type { NodeDurableObjectId } from "@fragno-private/backoffice-node-runtime/node-durable-object-state";
import type { RpcStub } from "capnweb";

import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "../internal-object-request";
import {
  assertBackofficeObjectAddressAllowed,
  createBackofficeObjectRegistry,
  encodeBackofficeObjectAddress,
  type BackofficeObjectAddress,
  type BackofficeObjectBinding,
  type BackofficeObjectFactory,
  type BackofficeObjectHandle,
  type BackofficeObjectHttp,
  type BackofficeObjectRegistry,
} from "../object-registry";
import { forwardRequestOwnedResponse } from "../request-owned-response";

/** Object capabilities are acquired per call, never retained by application registry handles. */
export type GraftBackofficeObjectResolver = (
  binding: string,
  name: string,
) => RpcStub<{ fetch(request: Request): Promise<Response> }>;

/** Uses the same named object identity in HTTP, worker factories, and Pi configuration checks. */
export function createGraftBackofficeObjectId(binding: string, name: string): NodeDurableObjectId {
  return {
    name,
    toString: () => `${binding}:${name}`,
    equals: (other) => other.toString() === `${binding}:${name}`,
  };
}

/** Finite commands and native HTTP share host routing without leaking Cap'n Web capabilities. */
export function createGraftBackofficeObjectRegistry(options: {
  resolve: GraftBackofficeObjectResolver;
  env: BackofficeRuntimeEnv;
  nowEpochMs(): number;
}): BackofficeObjectRegistry {
  const factory: BackofficeObjectFactory = {
    get<TCommands>(
      binding: BackofficeObjectBinding<TCommands>,
      address: BackofficeObjectAddress,
    ): BackofficeObjectHandle<TCommands> {
      if (address.binding !== binding.name) {
        throw new Error("BACKOFFICE_GRAFT_OBJECT_BINDING_MISMATCH");
      }
      assertBackofficeObjectAddressAllowed(address);
      const name = encodeBackofficeObjectAddress(address);
      const commands = createGraftBackofficeCommands(
        options.resolve,
        binding.name,
        name,
      ) as TCommands;
      const http: BackofficeObjectHttp & { id: NodeDurableObjectId } = {
        id: createGraftBackofficeObjectId(binding.name, name),
        async fetch(request: Request) {
          using object = options.resolve(binding.name, name);
          return forwardRequestOwnedResponse(
            request,
            await object.fetch(removeBackofficeInternalContextHeader(request)),
          );
        },
        async fetchAuthorized(request, context) {
          using object = options.resolve(binding.name, name);
          return forwardRequestOwnedResponse(
            request,
            await object.fetch(
              await createAuthorizedBackofficeObjectRequest({
                request,
                address,
                context: {
                  execution: context.execution,
                  propagationContext: context.propagationContext ?? null,
                  authorization: context.authorization,
                },
                env: options.env,
                nowEpochMs: options.nowEpochMs(),
              }),
            ),
          );
        },
      };
      return { commands, http };
    },
  };
  return createBackofficeObjectRegistry(factory);
}

/** The authoritative command contract is supplied by the binding or Pi agent constructor. */
export function createGraftBackofficeCommands(
  resolve: GraftBackofficeObjectResolver,
  binding: string,
  name: string,
): object {
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") {
          return undefined;
        }
        return async (...args: unknown[]) => {
          using object = resolve(binding, name);
          const remote = object as unknown as Record<
            string,
            (...input: unknown[]) => Promise<unknown>
          >;
          return await remote[method](...args);
        };
      },
    },
  );
}
