import { Link, Outlet, redirect, useLoaderData, useOutletContext, useParams } from "react-router";
import type { TelegramChatSummary } from "@fragno-dev/telegram-fragment";
import type { Route } from "./+types/organisation-telegram-messages";
import { fetchTelegramChats, fetchTelegramConfig } from "./organisation-telegram-data";
import type { TelegramLayoutContext } from "./organisation-telegram-shared";

type TelegramMessagesLoaderData = {
  configError: string | null;
  chatsError: string | null;
  chats: TelegramChatSummary[];
};

export type TelegramMessagesOutletContext = {
  chats: TelegramChatSummary[];
  selectedChatId: string | null;
  basePath: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchTelegramConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      chatsError: null,
      chats: [],
    } satisfies TelegramMessagesLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/organisations/${params.orgId}/telegram/configuration`);
  }

  const { chats, chatsError } = await fetchTelegramChats(request, context, params.orgId);
  if (chatsError) {
    return {
      configError: null,
      chatsError,
      chats: [],
    } satisfies TelegramMessagesLoaderData;
  }

  return {
    configError: null,
    chatsError: null,
    chats,
  } satisfies TelegramMessagesLoaderData;
}

export default function BackofficeOrganisationTelegramMessagesLayout() {
  const { chats, configError, chatsError } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<TelegramLayoutContext>();
  const { chatId } = useParams();
  const selectedChatId = chatId ?? null;
  const basePath = `/backoffice/organisations/${orgId}/telegram/messages`;
  const isDetailRoute = Boolean(selectedChatId);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (chatsError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{chatsError}</div>
    );
  }

  if (!chats.length) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No chats yet. Once the bot joins a chat, it will appear here.
      </div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
      <div
        className={`${listVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Chats
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Chat overview</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
            {chats.length} total
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {chats.map((chat) => {
            const title = chat.title || chat.username || `Chat ${chat.id}`;
            const isSelected = chat.id === selectedChatId;
            return (
              <Link
                key={chat.id}
                to={`${basePath}/${chat.id}`}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
                }
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{title}</p>
                    <p className="text-xs text-[var(--bo-muted-2)]">
                      {chat.type} · {chat.id}
                    </p>
                  </div>
                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] uppercase tracking-[0.22em]">
                    {chat.isForum ? "Forum" : chat.type}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div
        className={`${detailVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            chats,
            selectedChatId,
            basePath,
          }}
        />
      </div>
    </section>
  );
}
