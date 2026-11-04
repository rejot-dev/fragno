import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { PageHeading } from "@fragno-private/design-system/layout/page-heading";
import { useMemo } from "react";
import { useOutletContext, useRevalidator } from "react-router";

import { requireBooks } from "../books/books.server";
import type { BooksOutletContext } from "../books/layout";
import type { Route } from "./+types/ask";
import { setUpBooksAgent } from "./ask.server";
import { BooksChat, BooksChatStart } from "./books-chat";

export function meta() {
  return [{ title: "Ask · Bookkeeping" }];
}

/**
 * Everyone in the client's workspace asks the administration's agent about its books. Opening the
 * page defines the agent, so it answers as Bookkeeping now asks it to.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  return { agent: await setUpBooksAgent(context) };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function AskPage({ loaderData }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const revalidator = useRevalidator();
  const { agent } = loaderData;
  const agentPath = `${base}/ask/agent`;
  const paths = useMemo(
    () => ({
      agentPath,
      historyPath: `${base}/ask/history`,
    }),
    [agentPath, base],
  );
  return (
    <>
      <PageHeading eyebrow={books.name} title="Ask" meta={null} actions={null} />
      {!agent.ok ? (
        <BackofficeSystemState
          tone="error"
          label="Ask"
          title="The assistant is not available"
          description={agent.error}
        />
      ) : (
        <div className="flex h-[calc(100svh-14rem)] min-h-[28rem] flex-col overflow-hidden border border-[var(--bo-border)]">
          {agent.provisioned ? (
            <BooksChat paths={paths} books={books} base={base} />
          ) : (
            // Starting the conversation provisions it; the page then shows it.
            <BooksChatStart agentPath={agentPath} onStarted={() => void revalidator.revalidate()} />
          )}
        </div>
      )}
    </>
  );
}
