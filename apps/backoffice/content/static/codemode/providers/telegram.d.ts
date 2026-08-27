// telegram tools
type TelegramCodemodeProvider = {
  /** Resolve Telegram attachment metadata. */
  getFile(input: TelegramGetFileInput): Promise<TelegramGetFileOutput>;
  /** Download a Telegram file and return its bytes. */
  downloadFile(input: TelegramDownloadFileInput): Promise<TelegramDownloadFileOutput>;
  /** Queue a message to be sent to a Telegram chat. */
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageOutput>;
  /** Send a Telegram chat action. */
  sendChatAction(input: TelegramSendChatActionInput): Promise<TelegramSendChatActionOutput>;
  /** Queue an edit of an existing Telegram message. */
  editMessage(input: TelegramEditMessageInput): Promise<TelegramEditMessageOutput>;
};
declare const telegram: TelegramCodemodeProvider;

type TelegramGetFileInput = {
  fileId: string;
};
type TelegramGetFileOutput = {
  fileId: string;
  fileUniqueId?: string | null;
  filePath?: string | null;
  fileSize?: number | null;
};
type TelegramDownloadFileInput = {
  fileId: string;
};
type TelegramDownloadFileOutput = {
  bytes: number[];
  contentType?: string;
};
type TelegramSendMessageInput = {
  chatId: string;
  text: string;
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
};
type TelegramSendMessageOutput = {
  ok: boolean;
  queued: boolean;
};
type TelegramSendChatActionInput = {
  chatId: string;
  action: "typing";
};
type TelegramSendChatActionOutput = {
  ok: boolean;
};
type TelegramEditMessageInput = {
  chatId: string;
  messageId: string;
  text: string;
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
  disableWebPagePreview?: boolean;
};
type TelegramEditMessageOutput = {
  ok: boolean;
  queued: boolean;
};
