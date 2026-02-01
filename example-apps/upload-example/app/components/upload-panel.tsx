import { useMemo, useState } from "react";
import type { UploadClient } from "~/uploads/upload-client";

type UploadProgress = {
  bytesUploaded: number;
  totalBytes: number;
  partsUploaded: number;
  totalParts?: number;
};

type FileListItem = {
  fileKey: string;
  fileKeyParts: (string | number)[];
  filename: string;
  status: string;
};

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const encodePart = (part: string | number): string => {
  if (typeof part === "string") {
    return `s~${base64UrlEncode(part)}`;
  }

  if (!Number.isFinite(part)) {
    throw new Error("File key number parts must be finite");
  }

  const serialized = String(part);
  if (serialized.includes(".") || serialized.includes("e") || serialized.includes("E")) {
    throw new Error("File key number parts must be integers");
  }

  return `n~${serialized}`;
};

const encodeFileKey = (parts: (string | number)[]) => {
  if (parts.length === 0) {
    return "";
  }

  return parts.map((part) => encodePart(part)).join(".");
};

const encodeFileKeyPrefix = (parts: (string | number)[]) => {
  if (parts.length === 0) {
    return "";
  }

  return `${encodeFileKey(parts)}.`;
};

const parseKeyPart = (value: string) => {
  if (!value) {
    return null;
  }
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== "") {
    return asNumber;
  }
  return value;
};

export type UploadPanelProps = {
  title: string;
  description: string;
  client: UploadClient;
  defaultCollection: string;
  accent: "amber" | "emerald" | "sky";
};

const accentClasses: Record<UploadPanelProps["accent"], string> = {
  amber: "from-amber-400/20 to-orange-500/10",
  emerald: "from-emerald-400/20 to-teal-500/10",
  sky: "from-sky-400/20 to-cyan-500/10",
};

export function UploadPanel({
  title,
  description,
  client,
  defaultCollection,
  accent,
}: UploadPanelProps) {
  const { useFiles, useUploadHelpers } = client;

  const helpers = useUploadHelpers();
  const [file, setFile] = useState<File | null>(null);
  const [collection, setCollection] = useState(defaultCollection);
  const [entityId, setEntityId] = useState("1");
  const [filterByPrefix, setFilterByPrefix] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const prefixParts = useMemo(() => {
    const parts = [] as (string | number)[];
    if (collection) {
      parts.push(collection);
    }
    const parsedId = parseKeyPart(entityId);
    if (parsedId !== null) {
      parts.push(parsedId);
    }
    return parts;
  }, [collection, entityId]);

  const prefix =
    filterByPrefix && prefixParts.length > 0 ? encodeFileKeyPrefix(prefixParts) : undefined;

  const listResponse = useFiles({
    query: {
      prefix: prefix ?? undefined,
      pageSize: "10",
    },
  });

  const files = (listResponse.data?.files ?? []) as FileListItem[];

  const handleUpload = async () => {
    if (!file) {
      setError("Pick a file before uploading.");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);
    setProgress(null);

    const keyParts = [...prefixParts, file.name];

    try {
      const result = await helpers.createUploadAndTransfer(file, {
        keyParts,
        onProgress: (value: UploadProgress) => setProgress(value),
      });

      setSuccess(`Uploaded ${result.file.fileKey}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (fileKeyParts: (string | number)[], filename: string) => {
    try {
      const response = await helpers.downloadFile(fileKeyParts);
      if (!response.ok) {
        const text = await response.text();
        let message = `Download failed (${response.status})`;
        if (text) {
          try {
            const payload = JSON.parse(text) as { message?: string };
            message = payload.message ?? text;
          } catch {
            message = text;
          }
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  };

  return (
    <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm backdrop-blur">
      <div className={`rounded-2xl bg-gradient-to-br ${accentClasses[accent]} p-6`}>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">{description}</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Upload
          </h2>
          <div className="mt-4 grid gap-4">
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Collection
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                value={collection}
                onChange={(event) => setCollection(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Entity ID
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                value={entityId}
                onChange={(event) => setEntityId(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              File
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>

            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {uploading ? "Uploading…" : "Start upload"}
            </button>

            {progress && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Progress</span>
                  <span>
                    {Math.round((progress.bytesUploaded / Math.max(progress.totalBytes, 1)) * 100)}%
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-slate-200">
                  <div
                    className="h-2 rounded-full bg-slate-900"
                    style={{
                      width: `${Math.round(
                        (progress.bytesUploaded / Math.max(progress.totalBytes, 1)) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {error && <p className="text-sm text-rose-600">{error}</p>}
            {success && <p className="text-sm text-emerald-600">{success}</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/70 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Files
              </h2>
              <p className="mt-2 text-xs text-slate-500">
                {filterByPrefix && prefix ? `Filtered by ${prefix}` : "Showing latest uploads"}
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={filterByPrefix}
                onChange={(event) => setFilterByPrefix(event.target.checked)}
              />
              Use prefix
            </label>
          </div>

          {listResponse.loading && <p className="mt-4 text-sm text-slate-500">Loading…</p>}

          {!listResponse.loading && files.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">No files yet.</p>
          )}

          <div className="mt-4 space-y-3">
            {files.map((fileItem: FileListItem) => (
              <div
                key={fileItem.fileKey}
                className="flex items-center justify-between rounded-xl border border-slate-200/70 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{fileItem.filename}</p>
                  <p className="text-xs text-slate-500">{fileItem.fileKey}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{fileItem.status}</span>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                    onClick={() => handleDownload(fileItem.fileKeyParts, fileItem.filename)}
                  >
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
