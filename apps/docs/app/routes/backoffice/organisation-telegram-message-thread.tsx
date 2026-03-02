import { useEffect, useRef } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useParams,
} from "react-router";
import type { TelegramMessageSummary } from "@fragno-dev/telegram-fragment";
import type { Route } from "./+types/organisation-telegram-message-thread";
import { fetchTelegramChatMessages, sendTelegramChatMessage } from "./organisation-telegram-data";
import { formatTimestamp } from "./organisation-telegram-shared";
import type { TelegramMessagesOutletContext } from "./organisation-telegram-messages";

type TelegramMessagesThreadData = {
  messages: TelegramMessageSummary[];
  messagesError: string | null;
};

type TelegramSendMessageActionData = {
  ok: boolean;
  message?: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.chatId) {
    throw new Response("Not Found", { status: 404 });
  }

  const messageResult = await fetchTelegramChatMessages(
    request,
    context,
    params.orgId,
    params.chatId,
    { order: "desc", pageSize: 50 },
  );

  return {
    messages: [...messageResult.messages].reverse(),
    messagesError: messageResult.messagesError,
  } satisfies TelegramMessagesThreadData;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId || !params.chatId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const text = formData.get("text");

  if (typeof text !== "string" || !text.trim()) {
    return {
      ok: false,
      message: "Message cannot be empty.",
    } satisfies TelegramSendMessageActionData;
  }

  const result = await sendTelegramChatMessage(request, context, params.orgId, params.chatId, {
    text: text.trim(),
  });

  if (result.error) {
    return {
      ok: false,
      message: result.error,
    } satisfies TelegramSendMessageActionData;
  }

  return {
    ok: true,
  } satisfies TelegramSendMessageActionData;
}

export default function BackofficeOrganisationTelegramMessageThread() {
  const { messages, messagesError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { chats, basePath } = useOutletContext<TelegramMessagesOutletContext>();
  const { chatId } = useParams();
  const isSending = navigation.state === "submitting";
  const selectedChat = chats.find((chat) => chat.id === chatId) ?? null;
  const chatTitle =
    selectedChat?.title || selectedChat?.username || (chatId ? `Chat ${chatId}` : "Chat");

  return (
    <ChatMessages
      chatId={chatId ?? ""}
      chatTitle={chatTitle}
      messages={messages}
      messagesError={messagesError}
      backPath={basePath}
      actionData={actionData}
      isSending={isSending}
    />
  );
}

function ChatMessages({
  chatId,
  chatTitle,
  messages,
  messagesError,
  backPath,
  actionData,
  isSending,
}: {
  chatId: string;
  chatTitle: string;
  messages: TelegramMessageSummary[];
  messagesError: string | null;
  backPath: string;
  actionData?: TelegramSendMessageActionData;
  isSending: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const sendError = actionData?.ok === false ? actionData.message : null;

  useEffect(() => {
    if (!actionData?.ok) {
      return;
    }
    formRef.current?.reset();
  }, [actionData?.ok]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [chatId, messages.length, messagesError]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
            Messages
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{chatTitle}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">Chat ID: {chatId}</p>
        </div>
        <Link
          to={backPath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to chats
        </Link>
      </div>

      <ScrollArea.Root className="relative overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <ScrollArea.Viewport ref={viewportRef} className="max-h-[420px] p-3">
          <ScrollArea.Content className="space-y-2">
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
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 select-none p-[2px]">
          <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
        </ScrollArea.Scrollbar>
        <ScrollArea.Corner className="bg-transparent" />
      </ScrollArea.Root>

      <Form ref={formRef} method="post" className="space-y-2">
        {sendError ? <div className="text-sm text-red-500">{sendError}</div> : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            name="text"
            rows={3}
            required
            minLength={1}
            placeholder="Write a message as the bot..."
            className="focus:ring-[color:var(--bo-accent)]/20 w-full flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
          />
          <button
            type="submit"
            disabled={isSending}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </Form>
    </div>
  );
}
