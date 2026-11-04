import { z } from "zod";

import { requireBooks } from "../books/books.server";
import type { Route } from "./+types/history";
import { booksAgentHistory } from "./ask.server";

const pageSchema = z.object({
  before: z.coerce.number().int().positive(),
  cursor: z.string().min(1).nullable(),
});

/** A page of the conversation from before its newest compaction, for the chat's earlier history. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const query = new URL(request.url).searchParams;
  const page = pageSchema.safeParse({
    before: query.get("before"),
    cursor: query.get("cursor"),
  });
  const headers = { "Cache-Control": "private, no-store" };
  if (!page.success) {
    return Response.json(
      { message: "Name the entry before which to read." },
      { status: 400, headers },
    );
  }
  const history = await booksAgentHistory(request, context, page.data);
  if (history === null) {
    return Response.json(
      { message: "Backoffice does not let you read this administration's agent." },
      { status: 403, headers },
    );
  }
  return Response.json(history, { headers });
}
