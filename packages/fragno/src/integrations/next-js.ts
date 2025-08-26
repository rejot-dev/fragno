export interface NextJsHandlers {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  PUT: (request: Request) => Promise<Response>;
  PATCH: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
}

export function toNextJsHandler<T extends { handler: (req: Request) => Promise<Response> }>(
  library: T,
): NextJsHandlers;
export function toNextJsHandler(handler: (req: Request) => Promise<Response>): NextJsHandlers;
export function toNextJsHandler(
  libraryOrHandler:
    | { handler: (req: Request) => Promise<Response> }
    | ((req: Request) => Promise<Response>),
): NextJsHandlers {
  const handler = async (request: Request) => {
    return "handler" in libraryOrHandler
      ? libraryOrHandler.handler(request)
      : libraryOrHandler(request);
  };

  return {
    GET: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
  };
}
