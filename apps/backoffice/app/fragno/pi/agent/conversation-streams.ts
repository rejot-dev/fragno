import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import type { Conversation, Cursor } from "@earendil-works/pi-durable";

import { piConversationReachQuery, readPiConversationReach } from "./conversation-reach";

const ENTRY_SCAN_PAGE_SIZE = 256;

function encodePiExportLine(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/** Only `history` reaches past the newest compaction or reset, as the chat does. */
export function createPiConversationExportStream(
  root: Conversation,
  config: PiAgentConfig,
  history: boolean,
) {
  async function* exportLines() {
    const reach = await readPiConversationReach(root, { history });
    yield encodePiExportLine({
      type: "pi-durable-agent",
      version: 3,
      order: "oldest-first",
      history,
      agent: {
        agentName: config.agentName,
        scope: config.scope,
      },
    });

    if (reach === null) {
      return;
    }
    let cursor: Cursor | undefined;
    do {
      const page = await root.entries(
        { order: "ascending", ...piConversationReachQuery(reach, null) },
        ENTRY_SCAN_PAGE_SIZE,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items.filter(reach.includes)) {
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
