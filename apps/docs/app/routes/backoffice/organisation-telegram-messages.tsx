import { Form, redirect, useLoaderData } from "react-router";
import type { TelegramChatSummary, TelegramMessageSummary } from "@fragno-dev/telegram-fragment";
import type { Route } from "./+types/organisation-telegram-messages";
import {
  fetchTelegramChatMessages,
  fetchTelegramChats,
  fetchTelegramConfig,
} from "./organisation-telegram-data";
import { formatTimestamp } from "./organisation-telegram-shared";

type TelegramMessagesLoaderData = {
  configError: string | null;
  chatsError: string | null;
  messagesError: string | null;
  chats: TelegramChatSummary[];
  selectedChatId: string | null;
  messages: TelegramMessageSummary[];
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
      messagesError: null,
      chats: [],
      selectedChatId: null,
      messages: [],
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
      messagesError: null,
      chats: [],
      selectedChatId: null,
      messages: [],
    } satisfies TelegramMessagesLoaderData;
  }

  const url = new URL(request.url);
  const requestedChatId = url.searchParams.get("chatId");
  let selectedChatId = requestedChatId;

  if (chats.length > 0 && (!selectedChatId || !chats.some((chat) => chat.id === selectedChatId))) {
    selectedChatId = chats[0]?.id ?? null;
    if (selectedChatId) {
      url.searchParams.set("chatId", selectedChatId);
      return redirect(`${url.pathname}${url.search}`);
    }
  }

  let messages: TelegramMessageSummary[] = [];
  let messagesError: string | null = null;

  if (selectedChatId) {
    const messageResult = await fetchTelegramChatMessages(
      request,
      context,
      params.orgId,
      selectedChatId,
      { order: "asc", pageSize: 50 },
    );
    messages = messageResult.messages;
    messagesError = messageResult.messagesError;
  }

  return {
    configError: null,
    chatsError: null,
    messagesError,
    chats,
    selectedChatId: selectedChatId ?? null,
    messages,
  } satisfies TelegramMessagesLoaderData;
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const chatId = formData.get("chatId");

  if (typeof chatId !== "string" || !chatId) {
    return redirect(`/backoffice/organisations/${params.orgId}/telegram/messages`);
  }

  const url = new URL(`/backoffice/organisations/${params.orgId}/telegram/messages`, request.url);
  url.searchParams.set("chatId", chatId);
  return redirect(`${url.pathname}${url.search}`);
}

export default function BackofficeOrganisationTelegramMessages() {
  const { chats, selectedChatId, messages, configError, chatsError, messagesError } =
    useLoaderData<typeof loader>();

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

  const selectedChat = chats.find((chat) => chat.id === selectedChatId) ?? null;

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
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
              <Form key={chat.id} method="post" className="w-full">
                <button
                  type="submit"
                  name="chatId"
                  value={chat.id}
                  className={
                    isSelected
                      ? "w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                      : "w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
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
                </button>
              </Form>
            );
          })}
        </div>
      </div>

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        {selectedChat ? (
          <ChatMessages
            chatId={selectedChat.id}
            chatTitle={selectedChat.title || selectedChat.username || selectedChat.id}
            messages={messages}
            messagesError={messagesError}
          />
        ) : (
          <div className="text-sm text-[var(--bo-muted)]">Select a chat to read messages.</div>
        )}
      </div>
    </section>
  );
}

function ChatMessages({
  chatId,
  chatTitle,
  messages,
  messagesError,
}: {
  chatId: string;
  chatTitle: string;
  messages: TelegramMessageSummary[];
  messagesError: string | null;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">Messages</p>
        <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{chatTitle}</h3>
        <p className="text-xs text-[var(--bo-muted-2)]">Chat ID: {chatId}</p>
      </div>

      <div className="backoffice-scroll max-h-[420px] space-y-2 overflow-y-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        {messagesError ? (
          <div className="text-sm text-red-500">{messagesError}</div>
        ) : messages.length > 0 ? (
          messages.map((message) => {
            const author =
              message.fromUser?.username ||
              message.fromUser?.firstName ||
              message.fromUser?.id ||
              "Unknown";
            const content = message.text ?? "(Non-text message)";
            return (
              <div
                key={message.id}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-[var(--bo-fg)]">{author}</p>
                  <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                    {formatTimestamp(message.sentAt)}
                  </span>
                </div>
                <p className="mt-2 text-sm text-[var(--bo-muted)]">{content}</p>
                {message.commandName ? (
                  <span className="mt-2 inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                    /{message.commandName}
                  </span>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="text-sm text-[var(--bo-muted)]">No messages in this chat yet.</div>
        )}
      </div>
    </div>
  );
}
