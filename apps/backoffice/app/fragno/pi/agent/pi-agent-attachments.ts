import { escapeAttribute, unescapeAttribute } from "./xml-attribute";

/** A file a message carried, uploaded to the workspace before the message was sent. */
export type PiAgentAttachment = { path: string; contentType: string; sizeBytes: number };

export const PI_AGENT_MAX_ATTACHMENTS = 16;

/** Where the chat uploads the files of messages to `agentName`, each in a folder of its own. */
export function piAgentAttachmentsFolder(agentName: string) {
  return `/workspace/uploads/agents/${agentName}/`;
}

/**
 * What the agent reads for a message: its text, then the files it carried by path. The model sees
 * only the paths and reads the files with its tools, so a file never enters the conversation.
 */
export function renderPiAgentPrompt(text: string, attachments: readonly PiAgentAttachment[]) {
  if (attachments.length === 0) {
    return text;
  }
  const files = attachments.map(
    ({ path, contentType, sizeBytes }) =>
      `<file path="${escapeAttribute(path)}" type="${escapeAttribute(contentType)}" size="${sizeBytes}"/>\n`,
  );
  const block = `<backoffice-attachments>\n${files.join("")}</backoffice-attachments>`;
  return text === "" ? block : `${text}\n\n${block}`;
}

const ATTACHMENTS_PATTERN =
  /(?:^|\n\n)<backoffice-attachments>\n((?:<file path="[^"]*" type="[^"]*" size="\d+"\/>\n)+)<\/backoffice-attachments>$/u;
const ATTACHMENT_PATTERN = /<file path="([^"]*)" type="([^"]*)" size="(\d+)"\/>/gu;

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
    attachments: [...match[1].matchAll(ATTACHMENT_PATTERN)].map(([, path, contentType, size]) => ({
      path: unescapeAttribute(path),
      contentType: unescapeAttribute(contentType),
      sizeBytes: Number(size),
    })),
  };
}
