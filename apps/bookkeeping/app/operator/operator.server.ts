import type { SessionUser } from "../../workers/auth/auth";
import { isOperator, requireSessionUser } from "../auth/session.server";

/** The signed-in operator; to anyone else, the operator's pages do not exist. */
export async function requireOperator(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isOperator(user)) {
    throw new Response("This page does not exist.", { status: 404 });
  }
  return user;
}
