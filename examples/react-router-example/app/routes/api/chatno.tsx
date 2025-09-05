import { createChatno } from "@fragno-dev/chatno";
import type { Route } from "./+types/chatno";

// For GET
export async function loader({ request }: Route.LoaderArgs) {
  const chatno = createChatno();
  return await chatno.handler(request);
}

// For POST, PUT, PATCH, DELETE, etc
export async function action({ request }: Route.ActionArgs) {
  const chatno = createChatno();
  return await chatno.handler(request);
}
