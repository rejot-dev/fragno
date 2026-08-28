import type { BackofficeActionRpcContext, BackofficeObjectHandle } from "./object-registry";

const unusedObjectFetch = async (): Promise<Response> => {
  throw new Error("This Backoffice object test double does not implement HTTP fetch.");
};

export function createBackofficeObjectTestHandle<TCommands>(
  commands: TCommands,
  fetch: (request: Request) => Promise<Response> = unusedObjectFetch,
  fetchAuthorized: (
    request: Request,
    context: BackofficeActionRpcContext,
  ) => Promise<Response> = async (request) => await fetch(request),
): BackofficeObjectHandle<TCommands> {
  return {
    commands,
    http: { fetch, fetchAuthorized },
  };
}
