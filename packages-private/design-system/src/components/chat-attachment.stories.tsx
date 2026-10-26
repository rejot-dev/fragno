import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "./button";
import {
  ChatAttachmentDropZone,
  ChatComposerAttachButton,
  ChatComposerAttachments,
  ChatMessageAttachments,
  type ChatAttachmentFile,
  type ChatAttachmentUpload,
  type ChatComposerAttachmentItem,
  type ChatMessageAttachmentItem,
} from "./chat-attachment";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerModel,
  ChatComposerToolbar,
  chatComposerInputClassName,
} from "./chat-composer";
import { ChatAssistantMessage, ChatUserMessage } from "./chat-message";
import { ChatPromptField, ChatStartFooter, ChatStartPanel } from "./chat-start";
import { SAMPLE_TIME } from "./chat-story-support";
import {
  ChatColumn,
  ChatThread,
  ChatTurnSpacer,
  ChatViewport,
  ChatViewportFooter,
} from "./chat-thread";
import { ContextUsageMeter } from "./context-usage-meter";

export default { title: "Agents/Chat attachments" };

// Inline so the stories render offline.
function svg(width: number, height: number, body: string) {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  )}`;
}

const RECEIPT = svg(
  600,
  800,
  `<rect width="600" height="800" fill="#5b4636"/>
  <rect width="600" height="800" fill="url(#g)" opacity=".35"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#c9a27e"/></linearGradient></defs>
  <g transform="rotate(-4 300 400)">
    <rect x="150" y="70" width="300" height="660" fill="#f7f4ec"/>
    <rect x="190" y="120" width="220" height="22" fill="#2b2b2b"/>
    <rect x="230" y="156" width="140" height="10" fill="#9a968c"/>
    ${[220, 260, 300, 340, 380]
      .map(
        (y) =>
          `<rect x="180" y="${y}" width="150" height="10" fill="#6d6a62"/><rect x="370" y="${y}" width="50" height="10" fill="#6d6a62"/>`,
      )
      .join("")}
    <rect x="180" y="430" width="240" height="2" fill="#bdb8ac"/>
    <rect x="180" y="455" width="90" height="16" fill="#2b2b2b"/><rect x="345" y="455" width="75" height="16" fill="#2b2b2b"/>
    ${[530, 545, 560, 575, 590, 605]
      .map(
        (y, index) =>
          `<rect x="${200 + (index % 3) * 6}" y="${y}" width="${200 - index * 7}" height="7" fill="#1d1d1d"/>`,
      )
      .join("")}
  </g>`,
);

const DASHBOARD = svg(
  1280,
  800,
  `<rect width="1280" height="800" fill="#f5f6fa"/>
  <rect width="220" height="800" fill="#1b1f3b"/>
  ${[90, 140, 190, 240].map((y) => `<rect x="32" y="${y}" width="${y === 140 ? 156 : 120}" height="14" rx="3" fill="${y === 140 ? "#8f9bff" : "#4a5182"}"/>`).join("")}
  ${[0, 1, 2]
    .map(
      (index) =>
        `<rect x="${260 + index * 330}" y="48" width="300" height="130" rx="8" fill="#fff"/><rect x="${284 + index * 330}" y="76" width="90" height="12" fill="#a3a8c3"/><rect x="${284 + index * 330}" y="108" width="${150 - index * 20}" height="32" fill="#1b1f3b"/>`,
    )
    .join("")}
  <rect x="260" y="210" width="960" height="540" rx="8" fill="#fff"/>
  <polyline fill="none" stroke="#4f5bd5" stroke-width="6" points="300,680 420,600 540,630 660,500 780,540 900,400 1020,430 1160,300"/>
  <polyline fill="none" stroke="#2fb38f" stroke-width="6" points="300,700 420,690 540,660 660,650 780,600 900,610 1020,560 1160,520"/>`,
);

const WHITEBOARD = svg(
  900,
  700,
  `<rect width="900" height="700" fill="#d8d4cc"/>
  <rect x="60" y="50" width="780" height="560" fill="#fbfbf8"/>
  <rect x="120" y="110" width="200" height="110" rx="10" fill="none" stroke="#1f5fbf" stroke-width="6"/>
  <rect x="560" y="110" width="200" height="110" rx="10" fill="none" stroke="#1f5fbf" stroke-width="6"/>
  <rect x="340" y="380" width="220" height="120" rx="10" fill="none" stroke="#c03c3c" stroke-width="6"/>
  <path d="M320 165 L560 165 M220 220 Q240 330 340 420 M660 220 Q640 330 560 420" fill="none" stroke="#333" stroke-width="5"/>
  <rect x="60" y="610" width="780" height="22" fill="#9c958a"/>`,
);

const CHART = svg(
  800,
  800,
  `<rect width="800" height="800" fill="#101425"/>
  ${[0, 1, 2, 3, 4, 5]
    .map(
      (index) =>
        `<rect x="${110 + index * 105}" y="${680 - [220, 340, 280, 460, 390, 560][index]}" width="70" height="${[220, 340, 280, 460, 390, 560][index]}" rx="6" fill="${index === 5 ? "#7d8cff" : "#3a4377"}"/>`,
    )
    .join("")}
  <rect x="90" y="690" width="640" height="3" fill="#3a4377"/>`,
);

const FILES = {
  receipt: {
    name: "IMG_4821.jpg",
    contentType: "image/jpeg",
    sizeBytes: 2_480_000,
    previewUrl: RECEIPT,
  },
  dashboard: {
    name: "Screenshot 2026-10-24 at 14.02.11.png",
    contentType: "image/png",
    sizeBytes: 812_000,
    previewUrl: DASHBOARD,
  },
  whiteboard: {
    name: "whiteboard.webp",
    contentType: "image/webp",
    sizeBytes: 344_000,
    previewUrl: WHITEBOARD,
  },
  chart: {
    name: "q3-revenue.png",
    contentType: "image/png",
    sizeBytes: 128_000,
    previewUrl: CHART,
  },
  invoice: {
    name: "babbage-invoice-2026-7.pdf",
    contentType: "application/pdf",
    sizeBytes: 248_000,
    previewUrl: null,
  },
  ledger: {
    name: "october-ledger-export.csv",
    contentType: "text/csv",
    sizeBytes: 1_920_000,
    previewUrl: null,
  },
  contract: {
    name: "Master services agreement — Acme Bookkeeping (signed).docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 96_000,
    previewUrl: null,
  },
  broken: {
    name: "IMG_4822.jpg",
    contentType: "image/jpeg",
    sizeBytes: 2_310_000,
    previewUrl: "https://invalid.example/IMG_4822.jpg",
  },
} satisfies Record<string, ChatAttachmentFile>;

function sent(...files: ChatAttachmentFile[]): ChatMessageAttachmentItem[] {
  return files.map((file) => ({
    id: file.name,
    file,
    href: `#/workspace/uploads/agents/pi/${encodeURIComponent(file.name)}`,
  }));
}

function waiting(
  file: ChatAttachmentFile,
  upload: ChatAttachmentUpload,
): ChatComposerAttachmentItem {
  return { id: file.name, file, upload, onRemove: () => undefined };
}

const retry = () => undefined;

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-3xl flex-col">{children}</div>;
}

/** The chat composer with an attach button, holding `attachments` above its input. */
function AttachmentComposer({
  attachments,
  onFiles,
}: {
  attachments: readonly ChatComposerAttachmentItem[];
  onFiles: (files: File[]) => void;
}) {
  const uploading = attachments.some((item) => item.upload.kind === "uploading");
  return (
    <ChatComposer
      disabled={false}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <ChatComposerAttachments attachments={attachments} />
      <textarea rows={1} placeholder="Message Pi" className={chatComposerInputClassName} />
      <ChatComposerToolbar
        start={
          <>
            <ChatComposerAttachButton disabled={false} onFiles={onFiles} />
            <ChatComposerModel>Claude Opus 5.5</ChatComposerModel>
            <ContextUsageMeter tokens={42_000} contextWindow={200_000} />
          </>
        }
        end={
          <ChatComposerButton tone="accent" joined={false} type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Send"}
          </ChatComposerButton>
        }
      />
    </ChatComposer>
  );
}

export function ComposerStates() {
  return (
    <Column>
      <AttachmentComposer
        onFiles={() => undefined}
        attachments={[
          waiting(FILES.receipt, { kind: "uploaded" }),
          waiting(FILES.dashboard, { kind: "uploading", fraction: 0.42 }),
          waiting(FILES.whiteboard, {
            kind: "failed",
            message: "Connection lost",
            onRetry: retry,
          }),
          waiting(FILES.invoice, { kind: "uploaded" }),
          waiting(FILES.ledger, { kind: "uploading", fraction: null }),
          waiting(FILES.contract, {
            kind: "failed",
            message: "Larger than 25 MB",
            onRetry: retry,
          }),
        ]}
      />
    </Column>
  );
}

type SimulatedUpload = {
  id: string;
  file: ChatAttachmentFile;
  progress: number;
  failed: boolean;
  retried: boolean;
};

const MAX_SIMULATED_BYTES = 25 * 1024 * 1024;

/** Uploads that advance on a timer. Files over 25 MB fail partway; files named `fail`, once. */
function useSimulatedUploads(initial: readonly SimulatedUpload[]) {
  const [uploads, setUploads] = useState<readonly SimulatedUpload[]>(initial);
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setUploads((current) =>
        current.map((upload) => {
          if (upload.failed || upload.progress >= 1) {
            return upload;
          }
          const progress = Math.min(1, upload.progress + 0.06 + Math.random() * 0.08);
          const fails =
            (upload.file.sizeBytes > MAX_SIMULATED_BYTES ||
              (/fail/iu.test(upload.file.name) && !upload.retried)) &&
            progress > 0.5;
          return { ...upload, progress: fails ? upload.progress : progress, failed: fails };
        }),
      );
    }, 140);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(
    () => () => {
      for (const url of objectUrls.current) {
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  const add = (files: File[]) => {
    const added = files.map((file) => {
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (previewUrl !== null) {
        objectUrls.current.push(previewUrl);
      }
      return {
        id: crypto.randomUUID(),
        file: {
          name: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          previewUrl,
        },
        progress: 0,
        failed: false,
        retried: false,
      };
    });
    setUploads((current) => [...current, ...added]);
  };

  const items: ChatComposerAttachmentItem[] = uploads.map((upload) => ({
    id: upload.id,
    file: upload.file,
    upload: upload.failed
      ? {
          kind: "failed",
          message:
            upload.file.sizeBytes > MAX_SIMULATED_BYTES ? "Larger than 25 MB" : "Connection lost",
          onRetry: () => {
            setUploads((current) =>
              current.map((candidate) =>
                candidate.id === upload.id
                  ? { ...candidate, progress: 0, failed: false, retried: true }
                  : candidate,
              ),
            );
          },
        }
      : upload.progress >= 1
        ? { kind: "uploaded" }
        : { kind: "uploading", fraction: upload.progress },
    onRemove: () => {
      setUploads((current) => current.filter((candidate) => candidate.id !== upload.id));
    },
  }));

  return { items, add };
}

/**
 * Attach with the paperclip, drop files anywhere on the frame, or paste an image into the input.
 * Uploads are simulated; a file named `fail` fails once.
 */
export function ComposerInteractive() {
  const uploads = useSimulatedUploads([
    { id: "receipt", file: FILES.receipt, progress: 1, failed: false, retried: false },
    { id: "invoice", file: FILES.invoice, progress: 0.1, failed: false, retried: false },
  ]);
  return (
    <div className="flex h-[22rem] flex-col border border-dashed border-[color:var(--bo-border)]">
      <ChatAttachmentDropZone disabled={false} onFiles={uploads.add}>
        <div className="flex flex-1 flex-col justify-end p-4">
          <Column>
            <AttachmentComposer attachments={uploads.items} onFiles={uploads.add} />
          </Column>
        </div>
      </ChatAttachmentDropZone>
    </div>
  );
}

export function SentMessages() {
  return (
    <Column>
      <ChatUserMessage
        time={SAMPLE_TIME}
        attachments={<ChatMessageAttachments attachments={sent(FILES.receipt)} />}
      >
        <p>Can you book this one? It was lunch with the Babbage team.</p>
      </ChatUserMessage>
      <ChatUserMessage
        time={SAMPLE_TIME}
        attachments={<ChatMessageAttachments attachments={sent(FILES.dashboard, FILES.chart)} />}
      >
        <p>The chart on the right doesn&apos;t match the dashboard. Which one is wrong?</p>
      </ChatUserMessage>
      <ChatUserMessage
        time={SAMPLE_TIME}
        attachments={
          <ChatMessageAttachments
            attachments={sent(FILES.whiteboard, FILES.receipt, FILES.chart, FILES.dashboard)}
          />
        }
      >
        <p>Notes from today&apos;s planning session.</p>
      </ChatUserMessage>
      <ChatUserMessage
        time={SAMPLE_TIME}
        attachments={<ChatMessageAttachments attachments={sent(FILES.invoice, FILES.ledger)} />}
      >
        <p>Reconcile the invoice against the ledger export, please.</p>
      </ChatUserMessage>
      <ChatUserMessage
        time={SAMPLE_TIME}
        attachments={<ChatMessageAttachments attachments={sent(FILES.contract, FILES.broken)} />}
      >
        {null}
      </ChatUserMessage>
    </Column>
  );
}

/** A conversation about attached files, with more waiting in the composer. */
export function InAConversation() {
  const uploads = useSimulatedUploads([
    { id: "ledger", file: FILES.ledger, progress: 0.2, failed: false, retried: false },
  ]);
  return (
    <div className="flex h-[46rem] flex-col overflow-hidden border border-[color:var(--bo-border)]">
      <ChatAttachmentDropZone disabled={false} onFiles={uploads.add}>
        <ChatThread>
          <ChatViewport>
            <ChatColumn>
              <ChatUserMessage
                time={SAMPLE_TIME}
                attachments={
                  <ChatMessageAttachments attachments={sent(FILES.receipt, FILES.invoice)} />
                }
              >
                <p>Here&apos;s the receipt and Babbage&apos;s invoice. Do the totals match?</p>
              </ChatUserMessage>
              <ChatAssistantMessage author={{ name: "Pi", time: SAMPLE_TIME }} footer={null}>
                <p>
                  They do. The receipt in <code>IMG_4821.jpg</code> totals <strong>€121.00</strong>,
                  the same as invoice 2026-7 in <code>babbage-invoice-2026-7.pdf</code>. The invoice
                  has no line items, so I booked it as one line under{" "}
                  <em>Meals &amp; entertainment</em>.
                </p>
              </ChatAssistantMessage>
              <ChatTurnSpacer />
            </ChatColumn>
            <ChatViewportFooter alert={null}>
              <AttachmentComposer attachments={uploads.items} onFiles={uploads.add} />
            </ChatViewportFooter>
          </ChatViewport>
        </ChatThread>
      </ChatAttachmentDropZone>
    </div>
  );
}

/** The drop hint over a conversation while files are dragged onto it. */
export function DraggingFiles() {
  return (
    <div className="flex h-[22rem] flex-col border border-[color:var(--bo-border)]">
      <ChatAttachmentDropZone disabled={false} onFiles={() => undefined}>
        <div className="flex flex-1 flex-col justify-end p-4">
          <Column>
            <AttachmentComposer attachments={[]} onFiles={() => undefined} />
          </Column>
        </div>
      </ChatAttachmentDropZone>
    </div>
  );
}

// Storybook cannot drag a real file, so the story starts a drag that carries one.
DraggingFiles.play = ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["receipt"], "receipt.jpg", { type: "image/jpeg" }));
  canvasElement
    .querySelector("textarea")
    ?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
};

/** The first message to an agent, with files attached before it starts. */
export function StartWithAttachments() {
  const uploads = useSimulatedUploads([
    { id: "invoice", file: FILES.invoice, progress: 1, failed: false, retried: false },
    { id: "receipt", file: FILES.receipt, progress: 0.3, failed: false, retried: false },
  ]);
  return (
    <div className="flex h-[38rem] flex-col overflow-hidden border border-[color:var(--bo-border)]">
      <ChatAttachmentDropZone disabled={false} onFiles={uploads.add}>
        <ChatStartPanel
          title="Bookkeeper"
          description="Books receipts and invoices, and reconciles them against your ledger."
          details={
            <p className="font-mono text-xs">
              <span className="text-[var(--bo-muted-2)]">Permissions: </span>
              <span className="text-[var(--bo-fg)]">upload.read, models.extract, ledger.write</span>
            </p>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <ChatPromptField
              id="story-start-attachments"
              label="Message"
              rows={3}
              placeholder="Message Bookkeeper"
              defaultValue="Book these for October."
            />
            <div className="mt-2">
              <ChatComposerAttachments attachments={uploads.items} />
            </div>
            <ChatStartFooter
              note="Billing organization: Acme Bookkeeping"
              action={
                <div className="flex items-center justify-end gap-2">
                  <ChatComposerAttachButton disabled={false} onFiles={uploads.add} />
                  <Button type="submit" variant="solid">
                    Send
                  </Button>
                </div>
              }
              alert={null}
            />
          </form>
        </ChatStartPanel>
      </ChatAttachmentDropZone>
    </div>
  );
}
