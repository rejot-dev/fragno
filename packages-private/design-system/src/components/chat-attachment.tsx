import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";
import { formatBytes } from "./units";

/** A file attached to a message. */
export type ChatAttachmentFile = {
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Where an image shows its thumbnail; null for files without one, which show their type. */
  previewUrl: string | null;
};

/** How a composer attachment's upload is going. */
export type ChatAttachmentUpload =
  | { kind: "uploading"; fraction: number | null }
  | { kind: "uploaded" }
  | { kind: "failed"; message: string; onRetry: () => void };

export type ChatComposerAttachmentItem = {
  id: string;
  file: ChatAttachmentFile;
  upload: ChatAttachmentUpload;
  onRemove: () => void;
};

type PreviewableFile = ChatAttachmentFile & { previewUrl: string };

type WithPreview<T extends { file: ChatAttachmentFile }> = T & { file: PreviewableFile };

function hasPreviewFile(file: ChatAttachmentFile): file is PreviewableFile {
  return file.previewUrl !== null;
}

function hasPreview<T extends { file: ChatAttachmentFile }>(item: T): item is WithPreview<T> {
  return hasPreviewFile(item.file);
}

function isSettling(item: ChatComposerAttachmentItem): item is ChatComposerAttachmentItem & {
  upload: Exclude<ChatAttachmentUpload, { kind: "failed" }>;
} {
  return item.upload.kind !== "failed";
}

export type ChatMessageAttachmentItem = {
  id: string;
  file: ChatAttachmentFile;
  /** Opens the file where it was saved. */
  href: string;
};

const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/json": "JSON",
  "application/zip": "ZIP",
  "text/csv": "CSV",
  "text/plain": "Text",
  "text/markdown": "Markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};

function typeLabel({ name, contentType }: ChatAttachmentFile) {
  const known = TYPE_LABELS[contentType];
  if (known !== undefined) {
    return known;
  }
  if (contentType.startsWith("image/")) {
    return contentType.slice("image/".length).toUpperCase();
  }
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(name)?.[1];
  return extension === undefined ? "File" : extension.toUpperCase();
}

function typeIcon({ contentType }: ChatAttachmentFile): IconName {
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("audio/")) {
    return "music";
  }
  if (contentType.startsWith("video/")) {
    return "film";
  }
  if (contentType === "application/zip") {
    return "archive";
  }
  if (contentType === "text/csv" || contentType.includes("spreadsheet")) {
    return "grid";
  }
  if (contentType === "application/pdf" || contentType.startsWith("text/")) {
    return "file-text";
  }
  return "file";
}

function percent(fraction: number) {
  return Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
}

function uploadNote(upload: ChatAttachmentUpload, file: ChatAttachmentFile) {
  if (upload.kind === "uploading") {
    return upload.fraction === null ? "Uploading…" : `Uploading… ${percent(upload.fraction)}%`;
  }
  if (upload.kind === "failed") {
    return upload.message;
  }
  return `${typeLabel(file)} · ${formatBytes(file.sizeBytes)}`;
}

const IMAGE_CLASS_NAME =
  "outline -outline-offset-1 outline-[oklch(0_0_0/0.1)] dark:outline-[oklch(1_0_0/0.1)]";

/**
 * An image's thumbnail, cropped to fill its frame. An image that fails to load hands its place to
 * `fallback`, which shows the file without one.
 */
function Thumbnail({
  file,
  className,
  fallback,
}: {
  file: PreviewableFile;
  className: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return fallback;
  }
  return (
    <img
      src={file.previewUrl}
      alt={file.name}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => {
        setFailed(true);
      }}
      className={cn("object-cover", IMAGE_CLASS_NAME, className)}
    />
  );
}

/** A file's name, cut short in its middle so the extension stays readable. */
function FileName({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  const split = dot > 0 && name.length - dot <= 8;
  return (
    <span title={name} className="flex min-w-0 text-xs font-medium text-[var(--bo-fg)]">
      <span className="truncate">{split ? name.slice(0, dot) : name}</span>
      {split ? <span className="shrink-0">{name.slice(dot)}</span> : null}
    </span>
  );
}

/** The file's type in the square a thumbnail would fill. */
function TypeTile({ file, tone }: { file: ChatAttachmentFile; tone: "neutral" | "failed" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[3px]",
        tone === "failed"
          ? "bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"
          : "bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
      )}
    >
      <Icon name={tone === "failed" ? "alert-circle" : typeIcon(file)} className="size-4" />
      <span className="max-w-9 truncate text-[8px] leading-none font-semibold tracking-[0.06em] uppercase">
        {typeLabel(file)}
      </span>
    </span>
  );
}

// A small control over a tile's corner. The pseudo-element widens its hit area to 32px, which the
// tile's own size allows without it reaching the next tile.
const CORNER_BUTTON_CLASS_NAME =
  "absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-[oklch(0_0_0/0.62)] text-white backdrop-blur-sm transition-[background-color,scale] duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] hover:bg-[oklch(0_0_0/0.8)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/50 focus-visible:outline-none active:scale-[0.96]";

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      title="Remove"
      onClick={onRemove}
      className={CORNER_BUTTON_CLASS_NAME}
    >
      <Icon name="x" className="size-3" strokeWidth={2.5} />
    </button>
  );
}

/** A bar along a tile's bottom edge; without a fraction it sweeps until the size is known. */
function UploadBar({ fraction }: { fraction: number | null }) {
  return (
    <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-[oklch(0_0_0/0.12)]">
      <span
        className={cn(
          "block h-full bg-[var(--bo-accent)] transition-[width] duration-200 ease-out",
          fraction === null && "w-1/3 animate-pulse",
        )}
        style={fraction === null ? undefined : { width: `${percent(fraction)}%` }}
      />
    </span>
  );
}

/** An image waiting in the composer, as its thumbnail, until it uploads or fails. */
function ComposerImageTile({
  item: { file, upload, onRemove },
}: {
  item: WithPreview<ChatComposerAttachmentItem> & {
    upload: Exclude<ChatAttachmentUpload, { kind: "failed" }>;
  };
}) {
  return (
    <li
      title={`${file.name} · ${uploadNote(upload, file)}`}
      className="relative size-16 shrink-0 overflow-hidden rounded-[4px] bg-[var(--bo-panel-2)] shadow-[var(--bo-selected-shadow)]"
    >
      <Thumbnail
        file={file}
        className={cn(
          "size-full transition-opacity duration-200 ease-out",
          upload.kind === "uploaded" ? "opacity-100" : "opacity-55",
        )}
        fallback={
          <span className="flex size-full items-center justify-center">
            <TypeTile file={file} tone="neutral" />
          </span>
        }
      />
      <span className="sr-only">
        {file.name}, {uploadNote(upload, file)}
      </span>
      {upload.kind === "uploading" ? <UploadBar fraction={upload.fraction} /> : null}
      <RemoveButton name={file.name} onRemove={onRemove} />
    </li>
  );
}

/**
 * A document waiting in the composer, by its type, name, and upload. A failed image shows here too,
 * as a small thumbnail, so there is room to say why it failed.
 */
function ComposerFileTile({
  item: { file, upload, onRemove },
}: {
  item: ChatComposerAttachmentItem;
}) {
  const failed = upload.kind === "failed";
  const typeTile = <TypeTile file={file} tone={failed ? "failed" : "neutral"} />;
  return (
    <li
      className={cn(
        "relative flex h-16 w-60 shrink-0 items-center gap-2.5 overflow-hidden rounded-[4px] bg-[var(--bo-selected-bg)] pr-7 pl-3 shadow-[var(--bo-selected-shadow)]",
        failed && "ring-1 ring-[color:var(--bo-failed)] ring-inset",
      )}
    >
      {hasPreviewFile(file) ? (
        <Thumbnail file={file} className="size-10 shrink-0 rounded-[3px]" fallback={typeTile} />
      ) : (
        typeTile
      )}
      <span className="min-w-0 flex-1">
        <FileName name={file.name} />
        <span
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] tabular-nums",
            failed ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted-2)]",
          )}
        >
          <span title={failed ? upload.message : undefined} className="truncate">
            {uploadNote(upload, file)}
          </span>
          {failed ? (
            <button
              type="button"
              onClick={upload.onRetry}
              className="shrink-0 font-semibold text-[var(--bo-fg)] underline decoration-[var(--bo-border-strong)] underline-offset-2 hover:decoration-[var(--bo-fg)]"
            >
              Retry
            </button>
          ) : null}
        </span>
      </span>
      {upload.kind === "uploading" ? <UploadBar fraction={upload.fraction} /> : null}
      <RemoveButton name={file.name} onRemove={onRemove} />
    </li>
  );
}

/**
 * The files a message will carry, above the composer's input: images as thumbnails, other files
 * by type and name. Each shows its upload until it is saved, and can be removed before sending.
 */
export function ChatComposerAttachments({
  attachments,
}: {
  attachments: readonly ChatComposerAttachmentItem[];
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Attached files"
      className="backoffice-scroll flex gap-2 overflow-x-auto px-1 pt-1 pb-2"
    >
      {attachments.map((item) =>
        hasPreview(item) && isSettling(item) ? (
          <ComposerImageTile key={item.id} item={item} />
        ) : (
          <ComposerFileTile key={item.id} item={item} />
        ),
      )}
    </ul>
  );
}

/** Chooses files to attach, beside the composer's other controls. */
export function ChatComposerAttachButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label="Attach files"
        title="Attach files"
        onClick={() => input.current?.click()}
        className="inline-flex min-h-10 w-10 items-center justify-center rounded-[4px] text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:not-disabled:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Icon name="paperclip" className="size-4" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // Cleared so choosing the same file again, after removing it, still reports it.
          event.currentTarget.value = "";
          if (files.length > 0) {
            onFiles(files);
          }
        }}
      />
    </>
  );
}

function carriesFiles(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}

/**
 * Accepts files dropped on, or pasted into, what it wraps, such as a whole conversation, and
 * covers it with a drop hint while files are dragged over it.
 */
export function ChatAttachmentDropZone({
  disabled,
  onFiles,
  children,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  // Entering a child leaves its parent first, so a count tells when the drag left the zone.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (disabled || !carriesFiles(event)) {
          return;
        }
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (disabled || !carriesFiles(event)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (disabled || !carriesFiles(event)) {
          return;
        }
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (disabled || !carriesFiles(event)) {
          return;
        }
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = [...event.dataTransfer.files];
        if (files.length > 0) {
          onFiles(files);
        }
      }}
      onPaste={(event) => {
        const files = [...event.clipboardData.files];
        // Pasted text stays the input's; only pasted files become attachments.
        if (disabled || files.length === 0) {
          return;
        }
        event.preventDefault();
        onFiles(files);
      }}
    >
      {children}
      {dragging ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-[6px] border-2 border-dashed border-[color:var(--bo-accent)] bg-[color-mix(in_srgb,var(--bo-bg)_84%,transparent)] backdrop-blur-[2px]"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]">
              <Icon name="upload" className="size-4" />
            </span>
            <p className="text-sm font-semibold text-[var(--bo-fg)]">Drop files to attach</p>
            <p className="text-xs text-[var(--bo-muted)]">
              The agent reads them from your workspace
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// One image shows at its own shape; more crop to matching squares, so a row reads as a set.
function messageImageClassName(count: number) {
  if (count === 1) {
    return "max-h-72 max-w-full w-auto sm:max-w-sm";
  }
  return count === 2 ? "size-36 sm:size-44" : "size-24 sm:size-28";
}

function MessageFileCard({ file }: { file: ChatAttachmentFile }) {
  return (
    <span className="flex w-64 max-w-full items-center gap-2.5 rounded-[4px] bg-[var(--bo-selected-bg)] px-3 py-2.5 shadow-[var(--bo-selected-shadow)] transition-[background-color] duration-150 ease-out group-hover/attachment:bg-[var(--bo-panel-2)]">
      <TypeTile file={file} tone="neutral" />
      <span className="min-w-0 flex-1 text-left">
        <FileName name={file.name} />
        <span className="mt-0.5 block text-[10px] text-[var(--bo-muted-2)] tabular-nums">
          {typeLabel(file)} · {formatBytes(file.sizeBytes)}
        </span>
      </span>
      <Icon
        name="arrow-up-right"
        className="size-3.5 shrink-0 text-[var(--bo-muted-2)] opacity-0 transition-opacity duration-150 group-hover/attachment:opacity-100 group-focus-visible/attachment:opacity-100"
      />
    </span>
  );
}

const ATTACHMENT_LINK_CLASS_NAME =
  "group/attachment block rounded-[4px] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bo-bg)] focus-visible:outline-none";

/**
 * The files a sent message carried, above its bubble: images as thumbnails, then other files.
 * Each opens where it was saved.
 */
export function ChatMessageAttachments({
  attachments,
}: {
  attachments: readonly ChatMessageAttachmentItem[];
}) {
  const images = attachments.filter(hasPreview);
  const files = attachments.filter((item) => !hasPreview(item));
  return (
    <div className="mb-2 flex flex-col items-end gap-2">
      {images.length === 0 ? null : (
        <ul aria-label="Attached images" className="flex flex-wrap justify-end gap-2">
          {images.map(({ id, file, href }) => (
            <li key={id}>
              <a
                href={href}
                title={file.name}
                className={cn(
                  ATTACHMENT_LINK_CLASS_NAME,
                  "overflow-hidden shadow-[var(--bo-selected-shadow)]",
                )}
              >
                <Thumbnail
                  file={file}
                  className={cn(
                    "block rounded-[4px] bg-[var(--bo-panel-2)] transition-[filter] duration-150 ease-out group-hover/attachment:brightness-95",
                    messageImageClassName(images.length),
                  )}
                  fallback={<MessageFileCard file={file} />}
                />
              </a>
            </li>
          ))}
        </ul>
      )}
      {files.length === 0 ? null : (
        <ul aria-label="Attached files" className="flex flex-wrap justify-end gap-2">
          {files.map(({ id, file, href }) => (
            <li key={id} className="max-w-full">
              <a href={href} className={ATTACHMENT_LINK_CLASS_NAME}>
                <MessageFileCard file={file} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
