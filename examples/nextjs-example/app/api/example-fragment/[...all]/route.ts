import { toNextJsHandler } from "@fragno-dev/core/next-js";
import { createExampleFragmentServer } from "@/lib/example-fragment-server";

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(createExampleFragmentServer());
