import type { AnyFragnoRouteConfig } from "@fragno-dev/core/route";
import type {
  DatabaseServiceContext,
  DatabaseHandlerContext,
  FragnoPublicConfigWithDatabase,
} from "./db-fragment-definition-builder";
import { type AnyFragnoInstantiatedFragment, FragnoInstantiatedFragment } from "@fragno-dev/core";
import type { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import type { AwaitedPromisesInObject } from "./query/execute-unit-of-work";
import type { AnySchema } from "./schema/create";
import type { TypedUnitOfWork } from "./query/unit-of-work";

/**
 * Database-aware instantiated fragment that extends FragnoInstantiatedFragment.
 * This class provides additional database-specific functionality while maintaining
 * all the capabilities of the base fragment class.
 */
export class DatabaseFragnoInstantiatedFragment<
  TRoutes extends readonly AnyFragnoRouteConfig[],
  TDeps,
  TServices extends Record<string, unknown>,
  TServiceThisContext extends DatabaseServiceContext,
  THandlerThisContext extends DatabaseHandlerContext,
  TRequestStorage = {},
  TOptions extends FragnoPublicConfigWithDatabase = FragnoPublicConfigWithDatabase,
  TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment> = {},
> extends FragnoInstantiatedFragment<
  TRoutes,
  TDeps,
  TServices,
  TServiceThisContext,
  THandlerThisContext,
  TRequestStorage,
  TOptions,
  TLinkedFragments
> {
  constructor(params: {
    name: string;
    routes: TRoutes;
    deps: TDeps;
    services: TServices;
    mountRoute: string;
    serviceThisContext?: TServiceThisContext;
    handlerThisContext?: THandlerThisContext;
    storage: RequestContextStorage<TRequestStorage>;
    createRequestStorage?: () => TRequestStorage;
    options: TOptions;
    linkedFragments?: TLinkedFragments;
  }) {
    super(params);
  }

  uow<TResult>(
    callback: (context: {
      forSchema: <S extends AnySchema>(schema: S) => TypedUnitOfWork<S, [], unknown>;
      executeRetrieve: () => Promise<void>;
      executeMutate: () => Promise<void>;
      nonce: string;
      currentAttempt: number;
    }) => Promise<TResult> | TResult,
  ): Promise<AwaitedPromisesInObject<TResult>> {
    return this.inContext(async function () {
      return await this.uow(callback);
    });
  }
}

export const databaseFragnoInstantiatedFragmentCreator = {
  create<
    TRoutes extends readonly AnyFragnoRouteConfig[],
    TDeps,
    TServices extends Record<string, unknown>,
    TServiceThisContext extends DatabaseServiceContext,
    THandlerThisContext extends DatabaseHandlerContext,
    TRequestStorage = {},
    TOptions extends FragnoPublicConfigWithDatabase = FragnoPublicConfigWithDatabase,
    TLinkedFragments extends Record<string, AnyFragnoInstantiatedFragment> = {},
  >(params: {
    name: string;
    routes: TRoutes;
    deps: TDeps;
    services: TServices;
    mountRoute: string;
    serviceThisContext?: TServiceThisContext;
    handlerThisContext?: THandlerThisContext;
    storage: RequestContextStorage<TRequestStorage>;
    createRequestStorage?: () => TRequestStorage;
    options: TOptions;
    linkedFragments?: TLinkedFragments;
  }) {
    return new DatabaseFragnoInstantiatedFragment(params);
  },
};
