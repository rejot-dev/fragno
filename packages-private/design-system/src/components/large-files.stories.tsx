import { useState, type ReactNode } from "react";

import {
  LargeFilesView,
  type LargeFile,
  type LargeFilesAccess,
  type LargeFileTransfer,
} from "./large-files";

export default { title: "Files/Large files" };

const MAX_FILE_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

const FILES: readonly LargeFile[] = [
  {
    key: "datasets/2026-q3/orders.parquet",
    sizeBytes: 812_400_128,
    contentType: "application/vnd.apache.parquet",
  },
  {
    key: "datasets/2026-q3/customers.csv.gz",
    sizeBytes: 96_310_272,
    contentType: "application/gzip",
  },
  { key: "exports/crm-backup.tar", sizeBytes: 2_684_354_560, contentType: "application/x-tar" },
  {
    key: "recordings/2026-10-26-onboarding-call.mp4",
    sizeBytes: 1_288_490_189,
    contentType: "video/mp4",
  },
  { key: "recordings/2026-10-27-standup.m4a", sizeBytes: 41_943_040, contentType: "audio/mp4" },
  { key: "site-photos.zip", sizeBytes: 389_021_696, contentType: "application/zip" },
];

function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[96rem]">{children}</div>;
}

function editable(transfers: readonly LargeFileTransfer[]): LargeFilesAccess {
  return {
    kind: "editable",
    transfers,
    onUpload: () => {},
    onDismissTransfer: () => {},
    onDelete: async () => {},
  };
}

export function Overview() {
  return (
    <Page>
      <LargeFilesView
        files={FILES}
        prefix=""
        nextPageTo="?cursor=next"
        firstPageTo={null}
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={editable([])}
      />
    </Page>
  );
}

export function Uploading() {
  return (
    <Page>
      <LargeFilesView
        files={FILES.filter((file) => file.key.startsWith("recordings/"))}
        prefix="recordings/"
        nextPageTo={null}
        firstPageTo={null}
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={editable([
          {
            id: "1",
            key: "recordings/2026-10-27-all-hands.mp4",
            phase: "uploading",
            sentBytes: 734_003_200,
            totalBytes: 2_147_483_648,
          },
          {
            id: "2",
            key: "recordings/2026-10-27-demo.mov",
            phase: "completing",
            totalBytes: 512_000_000,
          },
          {
            id: "3",
            key: "recordings/raw.wav",
            phase: "failed",
            error: "Storage rejected the upload (403). Its URL expired; start the upload again.",
          },
        ])}
      />
    </Page>
  );
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Uploads a picked file in simulated steps and lists it, to try the whole flow. */
export function Interactive() {
  const [files, setFiles] = useState<readonly LargeFile[]>(FILES);
  const [transfers, setTransfers] = useState<readonly LargeFileTransfer[]>([]);
  const replace = (next: LargeFileTransfer) => {
    setTransfers((current) =>
      current.map((transfer) => (transfer.id === next.id ? next : transfer)),
    );
  };

  async function upload(file: File, key: string) {
    const id = crypto.randomUUID();
    const totalBytes = file.size;
    setTransfers((current) => [
      ...current,
      { id, key, phase: "uploading", sentBytes: 0, totalBytes },
    ]);
    for (let step = 1; step <= 8; step += 1) {
      await wait(300);
      replace({ id, key, phase: "uploading", sentBytes: (totalBytes * step) / 8, totalBytes });
    }
    replace({ id, key, phase: "completing", totalBytes });
    await wait(600);
    setTransfers((current) => current.filter((transfer) => transfer.id !== id));
    setFiles((current) =>
      [
        ...current.filter((existing) => existing.key !== key),
        { key, sizeBytes: totalBytes, contentType: file.type || "application/octet-stream" },
      ].toSorted((a, b) => a.key.localeCompare(b.key)),
    );
  }

  return (
    <Page>
      <LargeFilesView
        files={files}
        prefix=""
        nextPageTo={null}
        firstPageTo={null}
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={{
          kind: "editable",
          transfers,
          onUpload: (file, key) => {
            void upload(file, key);
          },
          onDismissTransfer: (id) => {
            setTransfers((current) => current.filter((transfer) => transfer.id !== id));
          },
          onDelete: async (key) => {
            await wait(500);
            setFiles((current) => current.filter((file) => file.key !== key));
          },
        }}
      />
    </Page>
  );
}

export function Empty() {
  return (
    <Page>
      <LargeFilesView
        files={[]}
        prefix=""
        nextPageTo={null}
        firstPageTo={null}
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={editable([])}
      />
    </Page>
  );
}

export function NoPrefixMatches() {
  return (
    <Page>
      <LargeFilesView
        files={[]}
        prefix="invoices/"
        nextPageTo={null}
        firstPageTo={null}
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={editable([])}
      />
    </Page>
  );
}

export function ReadOnly() {
  return (
    <Page>
      <LargeFilesView
        files={FILES}
        prefix=""
        nextPageTo={null}
        firstPageTo="?"
        error={null}
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={{ kind: "read-only" }}
      />
    </Page>
  );
}

export function LoadFailed() {
  return (
    <Page>
      <LargeFilesView
        files={[]}
        prefix=""
        nextPageTo={null}
        firstPageTo={null}
        error="Large files could not be listed: Blobs is unavailable (503)."
        maxFileBytes={MAX_FILE_BYTES}
        downloadHref={() => "#"}
        access={{ kind: "read-only" }}
      />
    </Page>
  );
}
