import { chatnoFragment } from "~/lib/chatno";

export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } =
  chatnoFragment.handlersFor("solid-start");
