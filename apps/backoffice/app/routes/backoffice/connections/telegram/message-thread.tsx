import { ScrollArea } from "@base-ui/react/scroll-area";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useParams,
} from "react-router";

import type { TelegramAttachment, TelegramMessageSummary } from "@fragno-dev/telegram-fragment";

import type { Route } from "./+types/message-thread";
import {
  buildTelegramAttachmentDownloadPath,
  buildTelegramAttachmentInlinePath,
  buildTelegramAttachmentPath,
} from "./attachment-paths";
import { fetchTelegramChatMessages, sendTelegramChatMessage } from "./data";
import type { TelegramMessagesOutletContext } from "./messages";
import { formatTimestamp } from "./shared";

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
  const { chatId, orgId } = useParams();
  const isSending = navigation.state === "submitting";
  const selectedChat = chats.find((chat) => chat.id === chatId) ?? null;
  const chatTitle =
    selectedChat?.title || selectedChat?.username || (chatId ? `Chat ${chatId}` : "Chat");

  return (
    <ChatMessages
      orgId={orgId ?? ""}
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

const buildTelegramInlineFilePath = (
  orgId: string,
  fileId: string,
  kind: TelegramAttachment["kind"],
): string =>
  buildTelegramAttachmentPath(orgId, {
    fileId,
    kind,
    disposition: "inline",
  });

const formatAttachmentKind = (kind: TelegramAttachment["kind"]): string => kind.replace(/_/g, " ");

const formatFileSize = (fileSize: number | undefined): string | null => {
  if (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize <= 0) {
    return null;
  }

  if (fileSize < 1024) {
    return `${fileSize} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = fileSize / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
};

const formatDuration = (duration: number | undefined): string | null => {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    return null;
  }

  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const describeAttachment = (attachment: TelegramAttachment): string[] => {
  const details: string[] = [];
  const fileSize = formatFileSize(attachment.fileSize);
  if (fileSize) {
    details.push(fileSize);
  }

  switch (attachment.kind) {
    case "photo": {
      if (attachment.width && attachment.height) {
        details.push(`${attachment.width}×${attachment.height}`);
      }
      details.push(
        `${attachment.sizes.length} size variant${attachment.sizes.length === 1 ? "" : "s"}`,
      );
      break;
    }
    case "voice": {
      const duration = formatDuration(attachment.duration);
      if (duration) {
        details.push(duration);
      }
      if (attachment.mimeType) {
        details.push(attachment.mimeType);
      }
      break;
    }
    case "audio": {
      const duration = formatDuration(attachment.duration);
      if (duration) {
        details.push(duration);
      }
      if (attachment.performer) {
        details.push(attachment.performer);
      }
      if (attachment.mimeType) {
        details.push(attachment.mimeType);
      }
      break;
    }
    case "document": {
      if (attachment.mimeType) {
        details.push(attachment.mimeType);
      }
      break;
    }
    case "video": {
      const duration = formatDuration(attachment.duration);
      if (duration) {
        details.push(duration);
      }
      if (attachment.width && attachment.height) {
        details.push(`${attachment.width}×${attachment.height}`);
      }
      if (attachment.mimeType) {
        details.push(attachment.mimeType);
      }
      break;
    }
    case "video_note": {
      const duration = formatDuration(attachment.duration);
      if (duration) {
        details.push(duration);
      }
      if (attachment.length) {
        details.push(`${attachment.length}px`);
      }
      break;
    }
    case "sticker": {
      if (attachment.emoji) {
        details.push(attachment.emoji);
      }
      if (attachment.width && attachment.height) {
        details.push(`${attachment.width}×${attachment.height}`);
      }
      if (attachment.isAnimated) {
        details.push("animated");
      }
      if (attachment.isVideo) {
        details.push("video");
      }
      break;
    }
    case "animation": {
      const duration = formatDuration(attachment.duration);
      if (duration) {
        details.push(duration);
      }
      if (attachment.width && attachment.height) {
        details.push(`${attachment.width}×${attachment.height}`);
      }
      if (attachment.mimeType) {
        details.push(attachment.mimeType);
      }
      break;
    }
  }

  return details;
};

const getAttachmentTitle = (attachment: TelegramAttachment): string => {
  switch (attachment.kind) {
    case "audio":
      return attachment.title ?? attachment.fileName ?? formatAttachmentKind(attachment.kind);
    case "document":
    case "video":
    case "animation":
      return attachment.fileName ?? formatAttachmentKind(attachment.kind);
    case "sticker":
      return attachment.setName ?? formatAttachmentKind(attachment.kind);
    default:
      return formatAttachmentKind(attachment.kind);
  }
};

const getAttachmentThumbnail = (attachment: TelegramAttachment) => {
  switch (attachment.kind) {
    case "photo":
      return attachment.sizes[0] ?? attachment.thumbnail;
    case "audio":
    case "document":
    case "video":
    case "video_note":
    case "sticker":
    case "animation":
      return attachment.thumbnail;
    default:
      return undefined;
  }
};

function TelegramAttachmentCard({
  orgId,
  messageId,
  attachment,
}: {
  orgId: string;
  messageId: string;
  attachment: TelegramAttachment;
}) {
  const details = describeAttachment(attachment);
  const thumbnail = getAttachmentThumbnail(attachment);
  const thumbnailUrl = thumbnail
    ? buildTelegramInlineFilePath(orgId, thumbnail.fileId, "photo")
    : null;
  const audioUrl =
    attachment.kind === "audio" || attachment.kind === "voice"
      ? buildTelegramAttachmentInlinePath(orgId, attachment)
      : null;

  return (
    <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-[var(--bo-fg)] capitalize">
            {getAttachmentTitle(attachment)}
          </p>
          <p className="text-[11px] text-[var(--bo-muted-2)] capitalize">
            {formatAttachmentKind(attachment.kind)}
          </p>
          {details.length > 0 ? (
            <p className="text-[11px] text-[var(--bo-muted-2)]">{details.join(" • ")}</p>
          ) : null}
          <p className="text-[11px] break-all text-[var(--bo-muted-2)]">{attachment.fileId}</p>
        </div>
        <a
          href={buildTelegramAttachmentDownloadPath(orgId, attachment)}
          download
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Download
        </a>
      </div>

      {thumbnailUrl ? (
        <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          <img
            src={thumbnailUrl}
            alt={`${getAttachmentTitle(attachment)} preview for ${messageId}`}
            loading="lazy"
            className="max-h-48 w-auto max-w-full object-contain"
          />
        </div>
      ) : null}

      {audioUrl ? (
        <audio controls preload="none" src={audioUrl} className="w-full">
          Your browser does not support audio playback.
        </audio>
      ) : null}
    </div>
  );
}

function ChatMessages({
  orgId,
  chatId,
  chatTitle,
  messages,
  messagesError,
  backPath,
  actionData,
  isSending,
}: {
  orgId: string;
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
  const [submissionKey, setSubmissionKey] = useState(0);

  useEffect(() => {
    if (actionData?.ok) {
      setSubmissionKey((prev) => prev + 1);
    }
  }, [actionData]);

  useEffect(() => {
    if (submissionKey === 0) {
      return;
    }
    formRef.current?.reset();
  }, [submissionKey]);

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
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Messages
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{chatTitle}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">Chat ID: {chatId}</p>
        </div>
        <Link
          to={backPath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
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
                const hasAttachments = message.attachments.length > 0;
                return (
                  <div
                    key={message.id}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold text-[var(--bo-fg)]">{author}</p>
                      <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {formatTimestamp(message.sentAt)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-[var(--bo-muted)]">{content}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.commandName ? (
                        <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                          /{message.commandName}
                        </span>
                      ) : null}
                      {hasAttachments ? (
                        <span className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase">
                          {message.attachments.length} attachment
                          {message.attachments.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    {hasAttachments ? (
                      <div className="mt-3 space-y-2 border-t border-[color:var(--bo-border)] pt-3">
                        <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                          Attachments
                        </p>
                        <div className="space-y-2">
                          {message.attachments.map((attachment) => (
                            <TelegramAttachmentCard
                              key={`${message.id}:${attachment.fileId}`}
                              orgId={orgId}
                              messageId={message.id}
                              attachment={attachment}
                            />
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-[var(--bo-muted)]">No messages in this chat yet.</div>
            )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 p-[2px] select-none">
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
            className="w-full flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
          />
          <button
            type="submit"
            disabled={isSending}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </Form>
    </div>
  );
}
