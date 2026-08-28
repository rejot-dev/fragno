import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";

const TELEGRAM_FILE_PATH_HEADER = "x-backoffice-telegram-file-path";
const TELEGRAM_FILE_SIZE_HEADER = "x-backoffice-telegram-file-size";
const TELEGRAM_AUTOMATION_FILE_DOWNLOAD_PREFIX = "/__backoffice/telegram/automation-files/";

export function telegramAutomationFileDownloadPath(fileId: string): string {
  const normalizedFileId = fileId.trim();
  if (!normalizedFileId) {
    throw new Error("Telegram automation file download requires a non-empty file id.");
  }
  return `${TELEGRAM_AUTOMATION_FILE_DOWNLOAD_PREFIX}${encodeURIComponent(normalizedFileId)}`;
}

export function telegramAutomationFileIdFromDownloadPath(pathname: string): string | null {
  if (!pathname.startsWith(TELEGRAM_AUTOMATION_FILE_DOWNLOAD_PREFIX)) {
    return null;
  }
  const encodedFileId = pathname.slice(TELEGRAM_AUTOMATION_FILE_DOWNLOAD_PREFIX.length);
  if (!encodedFileId || encodedFileId.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(encodedFileId);
  } catch {
    return null;
  }
}

export function createTelegramAutomationFileResponse(
  response: Response,
  metadata: TelegramAutomationFileMetadata,
): Response {
  const headers = new Headers(response.headers);
  if (metadata.filePath) {
    headers.set(TELEGRAM_FILE_PATH_HEADER, encodeURIComponent(metadata.filePath));
  }
  if (metadata.fileSize !== undefined && metadata.fileSize !== null) {
    headers.set(TELEGRAM_FILE_SIZE_HEADER, String(metadata.fileSize));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function readTelegramAutomationFileResponse(response: Response): {
  filePath: string | null;
  fileSize: number | null;
} {
  const encodedFilePath = response.headers.get(TELEGRAM_FILE_PATH_HEADER);
  const fileSizeHeader = response.headers.get(TELEGRAM_FILE_SIZE_HEADER);
  const fileSize = fileSizeHeader === null ? null : Number(fileSizeHeader);
  return {
    filePath: encodedFilePath ? decodeURIComponent(encodedFilePath) : null,
    fileSize: fileSize !== null && Number.isFinite(fileSize) ? fileSize : null,
  };
}
