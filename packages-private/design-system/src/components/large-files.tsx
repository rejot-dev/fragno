import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button, IconButton, IconButtonLink } from "./button";
import { Callout } from "./callout";
import { Dialog } from "./dialog";
import { Field } from "./field";
import { Icon } from "./icon";
import { InlineAlert } from "./inline-alert";
import { Input } from "./input";
import { ProgressMeter } from "./progress-meter";
import { formatBytes } from "./units";

export type LargeFile = {
  key: string;
  sizeBytes: number;
  contentType: string;
};

/** One file on its way into storage, from the browser's PUT to the server confirming it. */
export type LargeFileTransfer =
  | { id: string; key: string; phase: "uploading"; sentBytes: number; totalBytes: number }
  | { id: string; key: string; phase: "completing"; totalBytes: number }
  | { id: string; key: string; phase: "failed"; error: string };

/** What the viewer may do: people who can only read files see no upload or delete controls. */
export type LargeFilesAccess =
  | { kind: "read-only" }
  | {
      kind: "editable";
      transfers: readonly LargeFileTransfer[];
      onUpload: (file: File, key: string) => void;
      onDismissTransfer: (id: string) => void;
      /** Resolves once the file is gone, so the dialog stays open while it is deleted. */
      onDelete: (key: string) => Promise<void>;
    };

/**
 * Large files, kept in object storage apart from the workspace. They are listed and filtered by key
 * only, because their contents are never indexed.
 */
export function LargeFilesView({
  files,
  prefix,
  nextPageTo,
  firstPageTo,
  error,
  maxFileBytes,
  downloadHref,
  access,
}: {
  /** One page of files, ordered by key. */
  files: readonly LargeFile[];
  /** The key prefix the page is filtered by; empty when unfiltered. */
  prefix: string;
  /** Null on the last page. */
  nextPageTo: string | null;
  /** Null on the first page. */
  firstPageTo: string | null;
  error: string | null;
  maxFileBytes: number;
  /**
   * Where a file downloads from. It opens in a new tab, as browsers show some files, such as
   * videos, rather than save them.
   */
  downloadHref: (key: string) => string;
  access: LargeFilesAccess;
}) {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Object storage
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-[var(--bo-fg)]">
            Large files
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-[var(--bo-muted)]">
            Recordings, archives, and datasets of up to {formatBytes(maxFileBytes)} each. Uploads
            and downloads go straight between your browser and storage.
          </p>
        </div>
        {access.kind === "editable" ? (
          <LargeFileUploadButton prefix={prefix} maxFileBytes={maxFileBytes} access={access} />
        ) : null}
      </header>

      {error ? <InlineAlert>{error}</InlineAlert> : null}

      {access.kind === "editable" && access.transfers.length > 0 ? (
        <ul aria-label="Uploads" className="grid gap-2">
          {access.transfers.map((transfer) => (
            <li key={transfer.id}>
              <LargeFileTransferStatus
                transfer={transfer}
                onDismiss={() => {
                  access.onDismissTransfer(transfer.id);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-label="Large file list" className="space-y-3">
        <PrefixFilter prefix={prefix} />
        {files.length === 0 ? (
          <EmptyLargeFiles prefix={prefix} />
        ) : (
          <LargeFileTable files={files} downloadHref={downloadHref} access={access} />
        )}
        {nextPageTo || firstPageTo ? (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3">
            {firstPageTo ? (
              <Link
                to={firstPageTo}
                className="text-xs font-semibold text-[var(--bo-accent)] hover:underline"
              >
                First page
              </Link>
            ) : (
              <span />
            )}
            {nextPageTo ? (
              <Link
                to={nextPageTo}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--bo-accent)] hover:underline"
              >
                Next page
                <Icon name="arrow-right" className="size-3.5" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}

function PrefixFilter({ prefix }: { prefix: string }) {
  const navigate = useNavigate();

  return (
    <form
      method="get"
      role="search"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("prefix");
        // A new filter starts over at the first page, so the cursor is dropped.
        void navigate({
          search:
            typeof value === "string" && value ? `?${new URLSearchParams({ prefix: value })}` : "",
        });
      }}
    >
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <Icon
          name="folder"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--bo-muted-2)]"
        />
        <Input
          key={prefix}
          name="prefix"
          defaultValue={prefix}
          placeholder="Key starts with, e.g. recordings/"
          aria-label="Filter by key prefix"
          className="w-full pl-9"
        />
      </div>
      <Button type="submit" variant="secondary">
        Filter
      </Button>
      {prefix ? (
        <Link
          to={{ search: "" }}
          className="text-xs font-semibold text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
        >
          Clear
        </Link>
      ) : null}
    </form>
  );
}

function EmptyLargeFiles({ prefix }: { prefix: string }) {
  return (
    <div className="border border-dashed border-[var(--bo-border)] px-6 py-10 text-center">
      <Icon name="archive" className="mx-auto size-5 text-[var(--bo-muted-2)]" />
      <p className="mt-3 text-sm font-medium text-[var(--bo-fg)]">
        {prefix ? `No large files start with “${prefix}”` : "No large files yet"}
      </p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs text-pretty text-[var(--bo-muted-2)]">
        {prefix
          ? "The filter matches the start of a file's key, case and all, not its name or contents."
          : "Upload files too large for the workspace here. Agents can store them too, with blobs.createUpload."}
      </p>
    </div>
  );
}

function LargeFileTable({
  files,
  downloadHref,
  access,
}: {
  files: readonly LargeFile[];
  downloadHref: (key: string) => string;
  access: LargeFilesAccess;
}) {
  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="backoffice-scroll max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="bg-[var(--bo-panel-2)]">
            <tr className="text-[9px] font-semibold tracking-[0.16em] whitespace-nowrap text-[var(--bo-muted-2)] uppercase">
              <th scope="col" className="border-b border-[color:var(--bo-border)] px-3 py-2">
                Key
              </th>
              <th scope="col" className="border-b border-[color:var(--bo-border)] px-3 py-2">
                Type
              </th>
              <th
                scope="col"
                className="border-b border-[color:var(--bo-border)] px-3 py-2 text-right"
              >
                Size
              </th>
              <th scope="col" className="border-b border-[color:var(--bo-border)] px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--bo-border)]">
            {files.map((file) => (
              <tr key={file.key} className="hover:bg-[var(--bo-panel-2)]">
                <td className="max-w-[28rem] px-3 py-2">
                  <LargeFileKey fileKey={file.key} />
                </td>
                <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap text-[var(--bo-muted)]">
                  {file.contentType}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-[var(--bo-fg)] tabular-nums">
                  {formatBytes(file.sizeBytes)}
                </td>
                <td className="px-1 py-0.5">
                  <div className="flex justify-end">
                    <IconButtonLink
                      label={`Download ${file.key}`}
                      to={downloadHref(file.key)}
                      reloadDocument
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="download" className="size-4" />
                    </IconButtonLink>
                    {access.kind === "editable" ? (
                      <DeleteLargeFileControl fileKey={file.key} onDelete={access.onDelete} />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The folder part of a key recedes, so files read by name. */
function LargeFileKey({ fileKey }: { fileKey: string }) {
  const nameStart = fileKey.lastIndexOf("/") + 1;
  return (
    <span title={fileKey} className="block truncate">
      <span className="text-[var(--bo-muted-2)]">{fileKey.slice(0, nameStart)}</span>
      <span className="font-medium text-[var(--bo-fg)]">{fileKey.slice(nameStart)}</span>
    </span>
  );
}

type DeleteState = { kind: "idle" } | { kind: "confirming" } | { kind: "deleting" };

/** Deleting cannot be undone, so the row asks once more in place. */
function DeleteLargeFileControl({
  fileKey,
  onDelete,
}: {
  fileKey: string;
  onDelete: (key: string) => Promise<void>;
}) {
  const [state, setState] = useState<DeleteState>({ kind: "idle" });

  if (state.kind === "idle") {
    return (
      <IconButton
        label={`Delete ${fileKey}`}
        onClick={() => {
          setState({ kind: "confirming" });
        }}
      >
        <Icon name="trash-2" className="size-4" />
      </IconButton>
    );
  }

  const deleting = state.kind === "deleting";
  return (
    <span className="flex items-center gap-1 pl-1">
      <Button
        variant="danger"
        disabled={deleting}
        // The trash button it replaces had focus, so focus moves on to the confirmation.
        autoFocus
        aria-label={`Confirm deleting ${fileKey}`}
        onClick={() => {
          setState({ kind: "deleting" });
          // The page reports a failed deletion; the row returns to rest either way.
          void onDelete(fileKey).finally(() => {
            setState({ kind: "idle" });
          });
        }}
        className="min-h-8 px-2 text-xs"
      >
        {deleting ? "Deleting…" : "Delete"}
      </Button>
      <Button
        variant="ghost"
        disabled={deleting}
        onClick={() => {
          setState({ kind: "idle" });
        }}
        className="min-h-8 px-2 text-xs"
      >
        Keep
      </Button>
    </span>
  );
}

function LargeFileUploadButton({
  prefix,
  maxFileBytes,
  access,
}: {
  prefix: string;
  maxFileBytes: number;
  access: Extract<LargeFilesAccess, { kind: "editable" }>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<{ file: File; key: string } | null>(null);
  const tooLarge = chosen !== null && chosen.file.size > maxFileBytes;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            setChosen({ file, key: `${prefix}${file.name}` });
          }
        }}
      />
      <Button
        variant="accent"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <Icon name="upload" className="size-4" />
        Upload large file
      </Button>
      <Dialog
        open={chosen !== null}
        onOpenChange={(open) => {
          if (!open) {
            setChosen(null);
          }
        }}
        title="Upload large file"
        description="The key names the file in storage. Slashes group files, like folders."
      >
        {chosen ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              access.onUpload(chosen.file, chosen.key.trim());
              setChosen(null);
            }}
          >
            <p className="flex items-center justify-between gap-3 bg-[var(--bo-panel-2)] px-3 py-2 text-xs">
              <span className="truncate text-[var(--bo-fg)]">{chosen.file.name}</span>
              <span className="shrink-0 text-[var(--bo-muted)] tabular-nums">
                {formatBytes(chosen.file.size)}
              </span>
            </p>
            <Field
              label="Key"
              error={tooLarge ? `Large files can be at most ${formatBytes(maxFileBytes)}.` : null}
            >
              <Input
                value={chosen.key}
                required
                className="w-full font-mono"
                onChange={(event) => {
                  setChosen({ file: chosen.file, key: event.currentTarget.value });
                }}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setChosen(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="solid" disabled={tooLarge || !chosen.key.trim()}>
                Upload
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

function LargeFileTransferStatus({
  transfer,
  onDismiss,
}: {
  transfer: LargeFileTransfer;
  onDismiss: () => void;
}) {
  // Labels are set in capitals, so keys, which are case-sensitive, go in the detail.
  switch (transfer.phase) {
    case "uploading":
      return (
        <ProgressMeter
          tone="live"
          label="Uploading"
          percent={
            transfer.totalBytes === 0
              ? 100
              : Math.floor((transfer.sentBytes / transfer.totalBytes) * 100)
          }
          detail={`${transfer.key} · ${formatBytes(transfer.sentBytes)} of ${formatBytes(transfer.totalBytes)}`}
        />
      );
    case "completing":
      return (
        <ProgressMeter
          tone="waiting"
          label="Confirming with storage"
          percent={100}
          detail={`${transfer.key} · ${formatBytes(transfer.totalBytes)}`}
        />
      );
    case "failed":
      return (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Callout tone="failed" title="Upload failed">
              <span className="font-mono">{transfer.key}</span>: {transfer.error}
            </Callout>
          </div>
          <IconButton label={`Dismiss failed upload of ${transfer.key}`} onClick={onDismiss}>
            <Icon name="x" className="size-4" />
          </IconButton>
        </div>
      );
    default:
      throw new Error("Unknown large file transfer phase.", { cause: transfer satisfies never });
  }
}
