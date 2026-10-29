import { escapeAttribute, unescapeAttribute } from "./xml-attribute";

/** Where a file a message carried was uploaded: the workspace, or a blob when too large for it. */
export type PiAgentAttachmentLocation =
  | { kind: "workspace"; path: string }
  | { kind: "blob"; key: string };

/** A file a message carried, uploaded before the message was sent. */
export type PiAgentAttachment = PiAgentAttachmentLocation & {
  contentType: string;
  sizeBytes: number;
};

export const PI_AGENT_MAX_ATTACHMENTS = 16;

/**
 * Where the chat uploads the files of messages to `agentName`, each in a folder of its own: the
 * key of a workspace file under /workspace/, or of a blob.
 */
export function piAgentAttachmentsKeyPrefix(agentName: string) {
  return `uploads/agents/${agentName}/`;
}

function renderAttachment(attachment: PiAgentAttachment) {
  const location =
    attachment.kind === "workspace"
      ? `file path="${escapeAttribute(attachment.path)}"`
      : `blob key="${escapeAttribute(attachment.key)}"`;
  return `<${location} type="${escapeAttribute(attachment.contentType)}" size="${attachment.sizeBytes}"/>\n`;
}

/**
 * What the agent reads for a message: its text, then the files it carried by path or blob key. The
 * model sees only where they are and reads the files with its tools, so a file never enters the
 * conversation.
 */
export function renderPiAgentPrompt(text: string, attachments: readonly PiAgentAttachment[]) {
  if (attachments.length === 0) {
    return text;
  }
  const block = `<backoffice-attachments>\n${attachments.map(renderAttachment).join("")}</backoffice-attachments>`;
  return text === "" ? block : `${text}\n\n${block}`;
}

const ATTACHMENTS_PATTERN =
  /(?:^|\n\n)<backoffice-attachments>\n((?:<(?:file path|blob key)="[^"]*" type="[^"]*" size="\d+"\/>\n)+)<\/backoffice-attachments>$/u;
const ATTACHMENT_PATTERN = /<(file path|blob key)="([^"]*)" type="([^"]*)" size="(\d+)"\/>/gu;

/**
 * A message's text and the files it carried. Typing the block by hand only restyles the typist's
 * own message, like a notification request.
 */
export function parsePiAgentPrompt(prompt: string): {
  text: string;
  attachments: PiAgentAttachment[];
} {
  const match = ATTACHMENTS_PATTERN.exec(prompt);
  if (match === null) {
    return { text: prompt, attachments: [] };
  }
  return {
    text: prompt.slice(0, match.index),
    attachments: [...match[1].matchAll(ATTACHMENT_PATTERN)].map(
      ([, location, name, contentType, size]): PiAgentAttachment => {
        const file = { contentType: unescapeAttribute(contentType), sizeBytes: Number(size) };
        return location === "file path"
          ? { ...file, kind: "workspace", path: unescapeAttribute(name) }
          : { ...file, kind: "blob", key: unescapeAttribute(name) };
      },
    ),
  };
}
