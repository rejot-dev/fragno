export interface AstroHandlers {
  ALL: ({ request }: { request: Request }) => Promise<Response>;
}

/**
 * Converts a Fragno fragment handler to an Astro API route handler
 *
 * @param fragment - The Fragno fragment instance
 * @returns An Astro API route handler function
 */
export function toAstroHandler(handler: (req: Request) => Promise<Response>): AstroHandlers {
  return {
    ALL: async ({ request }) => {
      return handler(request);
    },
  };
}
