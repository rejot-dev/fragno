import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import type {
  Conversation,
  ConversationView,
  Cursor,
  WatchHandle,
} from "@earendil-works/pi-durable";

const ENTRY_SCAN_PAGE_SIZE = 256;

function encodePiConversationViewFrame(type: "snapshot" | "update", view: ConversationView) {
  return new TextEncoder().encode(`${JSON.stringify({ type, view })}\n`);
}

export function createPiConversationViewNdjsonStream(watch: WatchHandle<ConversationView>) {
  let cancelled = false;
  let pendingPulls = 0;
  let releaseBackpressure: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      controller.enqueue(encodePiConversationViewFrame("snapshot", watch.value));
      watch.start(async (view) => {
        if (!cancelled && (controller.desiredSize ?? 0) <= 0) {
          if (pendingPulls > 0) {
            pendingPulls -= 1;
          } else {
            await new Promise<void>((resolve) => {
              releaseBackpressure = resolve;
            });
            releaseBackpressure = null;
          }
        }
        if (!cancelled) {
          controller.enqueue(encodePiConversationViewFrame("update", view));
        }
      });
      void watch.closed.then((end) => {
        if (cancelled) {
          return;
        }
        if (end.reason === "listener_error") {
          controller.error(end.error);
          return;
        }
        controller.close();
      });
    },
    pull() {
      if (releaseBackpressure) {
        releaseBackpressure();
        return;
      }
      pendingPulls += 1;
    },
    async cancel() {
      cancelled = true;
      releaseBackpressure?.();
      await watch.stop();
    },
  });
}

function encodePiExportLine(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export function createPiConversationExportStream(root: Conversation, config: PiAgentConfig) {
  async function* exportLines() {
    yield encodePiExportLine({
      type: "pi-durable-agent",
      version: 2,
      order: "oldest-first",
      agent: {
        agentName: config.agentName,
        scope: config.scope,
      },
    });

    let cursor: Cursor | undefined;
    do {
      const page = await root.entries(
        { order: "ascending" },
        ENTRY_SCAN_PAGE_SIZE,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        yield encodePiExportLine({ type: "entry", entry });
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  const lines = exportLines();
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(controller) {
      const line = await lines.next();
      if (line.done) {
        controller.close();
        return;
      }
      controller.enqueue(line.value);
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
}
