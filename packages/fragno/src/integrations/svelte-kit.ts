type MaybePromise<T> = T | Promise<T>;

type SvelteKitRequestEvent = {
  request: Request;
};

export type SvelteKitRequestHandler = (event: SvelteKitRequestEvent) => MaybePromise<Response>;

export interface SvelteKitHandlers {
  GET: SvelteKitRequestHandler;
  POST: SvelteKitRequestHandler;
  PUT: SvelteKitRequestHandler;
  PATCH: SvelteKitRequestHandler;
  DELETE: SvelteKitRequestHandler;
  OPTIONS: SvelteKitRequestHandler;
}

export function toSvelteHandler<T extends { handler: (req: Request) => Promise<Response> }>(
  library: T,
): SvelteKitHandlers;
export function toSvelteHandler(handler: (req: Request) => Promise<Response>): SvelteKitHandlers;
export function toSvelteHandler(
  libraryOrHandler:
    | { handler: (req: Request) => Promise<Response> }
    | ((req: Request) => Promise<Response>),
): SvelteKitHandlers {
  const requestHandler: SvelteKitRequestHandler = async ({ request }) => {
    return "handler" in libraryOrHandler
      ? libraryOrHandler.handler(request)
      : libraryOrHandler(request);
  };

  return {
    GET: requestHandler,
    POST: requestHandler,
    PUT: requestHandler,
    PATCH: requestHandler,
    DELETE: requestHandler,
    OPTIONS: requestHandler,
  };
}
