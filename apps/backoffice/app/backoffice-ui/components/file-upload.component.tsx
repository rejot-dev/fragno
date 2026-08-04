import { Check, FileUp, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { UploadProgress } from "@fragno-dev/upload";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiInteractionHost } from "../interaction";

type UploadState = "idle" | "uploading" | "failed" | "complete";

const formattedBytes = (sizeBytes: number): string => {
  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1_048_576) {
    return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
};

const acceptsFile = (file: File, acceptedTypes: readonly string[]): boolean =>
  acceptedTypes.some((acceptedType) => {
    if (acceptedType.startsWith(".")) {
      return file.name.toLowerCase().endsWith(acceptedType.toLowerCase());
    }
    if (acceptedType.endsWith("/*")) {
      return file.type.startsWith(acceptedType.slice(0, -1));
    }
    return file.type.toLowerCase() === acceptedType.toLowerCase();
  });

export const FileUpload: ComponentFn<typeof backofficeUiCatalog, "FileUpload"> = ({
  props,
  bindings,
}) => {
  const host = useBackofficeUiInteractionHost();
  const inputId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const retryFileRef = useRef<File | undefined>(undefined);
  const [value, setValue] = useBoundProp<PreparedUploadedFileReference | null>(
    props.value,
    bindings?.value,
  );
  const [uploadState, setUploadState] = useState<UploadState>(value ? "complete" : "idle");
  const [progress, setProgress] = useState<UploadProgress>();
  const [error, setError] = useState<string>();
  const editable = host?.canEditWorkflowInput?.() !== false;
  const disabled = props.disabled || !editable || !host?.uploadPreparedFile;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const validityMessage =
      uploadState === "uploading"
        ? "Wait for the file upload to finish."
        : uploadState === "failed"
          ? "Retry the failed file upload."
          : props.required && !value
            ? "Choose a file."
            : "";
    input.setCustomValidity(validityMessage);
  }, [props.required, uploadState, value]);

  const upload = async (file: File) => {
    if (!host?.uploadPreparedFile || disabled) {
      return;
    }
    if (props.maxSizeBytes && file.size > props.maxSizeBytes) {
      setUploadState("failed");
      setError(`File exceeds the ${formattedBytes(props.maxSizeBytes)} limit.`);
      retryFileRef.current = undefined;
      return;
    }
    if (props.accept?.length && !acceptsFile(file, props.accept)) {
      setUploadState("failed");
      setError(`Choose one of these file types: ${props.accept.join(", ")}.`);
      retryFileRef.current = undefined;
      return;
    }

    retryFileRef.current = file;
    setUploadState("uploading");
    setProgress(undefined);
    setError(undefined);
    try {
      const reference = await host.uploadPreparedFile({
        scope: props.scope,
        file,
        bindingPath: bindings?.value,
        onProgress: setProgress,
      });
      setValue(reference);
      setUploadState("complete");
      retryFileRef.current = undefined;
    } catch (cause) {
      setUploadState("failed");
      setError(cause instanceof Error ? cause.message : "Could not upload this file.");
    }
  };

  const progressValue =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesUploaded / progress.totalBytes) * 100))
      : undefined;

  return (
    <div className="min-w-0">
      <label htmlFor={inputId} className="block text-xs font-semibold text-[var(--bo-foreground)]">
        {props.label}
        {props.required ? <span className="ml-1 text-[var(--bo-failed)]">*</span> : null}
      </label>
      {props.description ? (
        <p id={descriptionId} className="mt-1 text-[11px] leading-4 text-[var(--bo-muted)]">
          {props.description}
        </p>
      ) : null}

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={props.accept?.join(",")}
        disabled={disabled || uploadState === "uploading"}
        aria-describedby={`${props.description ? descriptionId : ""} ${statusId}`.trim()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            void upload(file);
          }
        }}
        className="sr-only"
      />

      <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center bg-[var(--bo-panel)] text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            {uploadState === "complete" ? (
              <Check className="size-4" />
            ) : (
              <FileUp className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-[var(--bo-foreground)]">
              {value?.filename ?? retryFileRef.current?.name ?? "No file selected"}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
              {uploadState === "uploading"
                ? progressValue === undefined
                  ? "Uploading…"
                  : `Uploading · ${progressValue}%`
                : value
                  ? `${formattedBytes(value.sizeBytes)} · Prepared`
                  : "The workflow will decide whether to keep this upload."}
            </p>
          </div>
          <label
            htmlFor={inputId}
            aria-disabled={disabled || uploadState === "uploading"}
            className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 text-[10px] font-semibold text-[var(--bo-foreground)] transition-[background-color,scale,opacity] duration-150 hover:bg-[var(--bo-panel-2)] active:scale-[0.96] aria-disabled:pointer-events-none aria-disabled:opacity-45"
          >
            {value ? "Replace" : "Choose file"}
          </label>
        </div>

        {uploadState === "uploading" ? (
          <progress
            max={100}
            value={progressValue}
            className="mt-3 h-1.5 w-full accent-[var(--bo-accent)]"
          />
        ) : null}

        {uploadState === "failed" && error ? (
          <div className="mt-3 flex items-start justify-between gap-3 border-t border-[color:var(--bo-border)] pt-3">
            <p role="alert" className="text-[10px] leading-4 text-[var(--bo-failed)]">
              {error}
            </p>
            {retryFileRef.current ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const file = retryFileRef.current;
                  if (file) {
                    void upload(file);
                  }
                }}
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 px-2 text-[10px] font-semibold text-[var(--bo-foreground)] transition-[scale,opacity] active:scale-[0.96] disabled:opacity-45"
              >
                <RefreshCw className="size-3" /> Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <p id={statusId} aria-live="polite" className="sr-only">
        {uploadState === "uploading"
          ? "Uploading file."
          : uploadState === "complete" && value
            ? `${value.filename} uploaded and prepared.`
            : uploadState === "failed"
              ? error
              : "No file selected."}
      </p>
      {!host?.uploadPreparedFile ? (
        <p className="mt-1.5 text-[10px] leading-4 text-[var(--bo-muted-2)]">
          File uploads are unavailable in this generated interface.
        </p>
      ) : null}
    </div>
  );
};
