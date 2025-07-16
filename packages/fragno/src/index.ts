export type FragnoConfig = {
  name: string;
};

export type FragnoLibrary = {
  config: FragnoConfig;
  handler: (req: Request) => Promise<Response>;
};

export function createLibrary(config: FragnoConfig): FragnoLibrary {
  return {
    config,
    handler: async (_req: Request) => {
      return new Response("Hello, world!");
    },
  };
}
