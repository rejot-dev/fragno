import type { Route } from "./+types/chatno";
import { createChatno } from "../../chatno/chatno.server";

// For GET
export async function loader({ request }: Route.LoaderArgs) {
  const { loader } = createChatno().handlersFor("react-router");
  return await loader(request);
}

// For POST, PUT, PATCH, DELETE, etc
export async function action({ request }: Route.ActionArgs) {
  const { action } = createChatno().handlersFor("react-router");
  return await action(request);
}
