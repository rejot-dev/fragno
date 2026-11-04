import { PI_AGENT_MAX_ATTACHMENTS } from "@fragno-dev/backoffice-api/v0/pi-conversation/prompt-attachments";
import { z } from "zod";

import { requireBooks, requireBooksSubmission } from "../books/books.server";
import type { Route } from "./+types/agent";
import { booksAgentSocketUrl, runBooksAgentRequest, type BooksAgentRequest } from "./ask.server";

/** Where the chat's socket connects now; each URL opens one connection, within a minute. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const url = await booksAgentSocketUrl(request, context);
  if (url === null) {
    return Response.json(
      { message: "Backoffice does not let you read this administration's agent." },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return Response.json({ url }, { headers: { "Cache-Control": "private, no-store" } });
}

const agentRequestSchema: z.ZodType<BooksAgentRequest> = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("ask"),
      requestId: z.string().trim().min(1).max(128),
      content: z.string().trim(),
      // The IDs of the documents the message carries, uploaded through `ask/documents` first.
      documents: z
        .string()
        .default("")
        .transform((ids) => (ids === "" ? [] : ids.split(",")))
        .pipe(z.array(z.uuid()).max(PI_AGENT_MAX_ATTACHMENTS)),
    })
    .refine((ask) => ask.content !== "" || ask.documents.length > 0, {
      message: "Write a question before sending.",
    }),
  z.object({ intent: z.literal("stop") }),
  z.object({ intent: z.literal("resume") }),
]);

/** What the chat answers a question, a stop, or a resume with: why Backoffice refused it, or null. */
export type BooksAgentAnswer = { error: string | null };

/** Everyone in the client's workspace asks the agent, and stops or resumes it. */
export async function action({ request, params }: Route.ActionArgs) {
  const context = await requireBooksSubmission(request, params, "keep");
  const parsed = agentRequestSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return Response.json(
      {
        error: parsed.error.issues[0]?.message ?? "Check the request.",
      } satisfies BooksAgentAnswer,
      { status: 400 },
    );
  }
  const error = await runBooksAgentRequest(context, parsed.data);
  return Response.json({ error } satisfies BooksAgentAnswer);
}
