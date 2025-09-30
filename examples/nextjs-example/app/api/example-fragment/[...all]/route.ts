import { createExampleFragmentServer } from "@/lib/example-fragment-server";

export const { GET, POST, PUT, PATCH, DELETE } =
  createExampleFragmentServer().handlersFor("nextjs");
