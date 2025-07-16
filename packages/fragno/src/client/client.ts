// import type { FragnoInstantiatedLibrary } from "../mod";

export interface FragnoClientHook {
  name: string;
}

export function wrapRouteQuery(_route: unknown): FragnoClientHook {
  throw new Error("Not implemented");
  // return async (query: unknown) => {
  //   const response = await route.handler(query);
  //   return response.json();
  // };
}
