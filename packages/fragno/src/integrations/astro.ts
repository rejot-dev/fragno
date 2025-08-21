export interface AstroHandlers {
  ALL: ({ request }: { request: Request }) => Promise<Response>;
}

/**
 * Converts a Fragno library handler to an Astro API route handler
 *
 * @param library - The Fragno library instance
 * @returns An Astro API route handler function
 */
export function toAstroHandler<T extends { handler: (req: Request) => Promise<Response> }>(
  library: T,
): AstroHandlers;
export function toAstroHandler(handler: (req: Request) => Promise<Response>): AstroHandlers;
export function toAstroHandler(
  libraryOrHandler:
    | { handler: (req: Request) => Promise<Response> }
    | ((req: Request) => Promise<Response>),
): AstroHandlers {
  const handler = async (request: Request) => {
    return "handler" in libraryOrHandler
      ? libraryOrHandler.handler(request)
      : libraryOrHandler(request);
  };
  return {
    ALL: async ({ request }) => handler(request),
  };
}
