import { createCodemodeSystemPrompt } from "@/fragno/codemode/state-prompt";
import { createRuntimeToolReferenceContext } from "@/fragno/runtime-tools/reference";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { Route } from "./+types/codemode-agents";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const assertDevOnlyLocalRequest = (request: Request) => {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const hostname = new URL(request.url).hostname;
  if (!localHostnames.has(hostname)) {
    throw new Response("Not Found", { status: 404 });
  }
};

export async function loader({ request }: Route.LoaderArgs) {
  assertDevOnlyLocalRequest(request);

  return new Response(
    createCodemodeSystemPrompt({
      families: runtimeToolFamilies.filter((family) => !family.hidden),
      context: createRuntimeToolReferenceContext(),
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/markdown; charset=utf-8",
      },
    },
  );
}
