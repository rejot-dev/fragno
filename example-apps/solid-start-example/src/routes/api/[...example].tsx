import { createExampleFragmentInstance } from "~/lib/example-fragment";

export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } =
  createExampleFragmentInstance().handlersFor("solid-start");
