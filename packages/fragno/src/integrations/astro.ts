export interface AstroHandlers {
  ALL: ({ request }: { request: Request }) => Promise<Response>;
}

/**
 * Converts a Fragno library handler to an Astro API route handler
 *
 * @param library - The Fragno library instance
 * @returns An Astro API route handler function
 */
export function toAstroHandler(handler: (req: Request) => Promise<Response>): AstroHandlers {
  return {
    ALL: async ({ request }) => {
      return handler(request);
    },
  };
}
