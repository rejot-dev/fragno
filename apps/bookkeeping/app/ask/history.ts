import { piAgentEntryRangeSchema } from "@fragno-dev/backoffice-api/v0/pi";

import { requireBooks } from "../books/books.server";
import type { Route } from "./+types/history";
import { booksAgentHistory } from "./ask.server";

/** A page of the agent's entries in an ID range, for the chat's transcript. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const query = new URL(request.url).searchParams;
  const range = piAgentEntryRangeSchema.safeParse({
    minEntryId: query.has("minEntryId") ? Number(query.get("minEntryId")) : undefined,
    maxEntryId: query.has("maxEntryId") ? Number(query.get("maxEntryId")) : undefined,
    order: query.get("order") ?? undefined,
    pageSize: query.has("pageSize") ? Number(query.get("pageSize")) : undefined,
  });
  const headers = { "Cache-Control": "private, no-store" };
  if (!range.success) {
    return Response.json(
      { message: "Name the entries to read as an ID range, an order, and a page size." },
      { status: 400, headers },
    );
  }
  const history = await booksAgentHistory(request, context, range.data);
  if (history === null) {
    return Response.json(
      { message: "Backoffice does not let you read this administration's agent." },
      { status: 403, headers },
    );
  }
  return Response.json(history, { headers });
}
