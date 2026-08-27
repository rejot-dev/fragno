// resend tools
type ResendCodemodeProvider = {
  /** Load a Resend thread with a page of messages and a Markdown snapshot. */
  getThread(input: ResendGetThreadInput): Promise<ResendGetThreadOutput>;
  /** List Resend email threads. */
  listThreads(input: ResendListThreadsInput): Promise<ResendListThreadsOutput>;
  /** Send a text reply into an existing Resend thread. */
  replyToThread(input: ResendReplyToThreadInput): Promise<ResendReplyToThreadOutput>;
};
declare const resend: ResendCodemodeProvider;

type ResendGetThreadInput = {
  cursor?: string;
  pageSize?: number;
  order?: "asc" | "desc";
  threadId: string;
};
type ResendGetThreadOutput = {
  thread: {
    id: string;
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    messageCount: number;
    /** ISO 8601 datetime string. */
    firstMessageAt: string;
    /** ISO 8601 datetime string. */
    lastMessageAt: string;
    lastDirection: string | null;
    lastMessagePreview: string | null;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
    replyToAddress: string | null;
  };
  messages: {
    id: string;
    threadId: string;
    direction: "inbound" | "outbound";
    status: string;
    from: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    providerEmailId: string | null;
    attachments: {
      id: string;
      filename: string | null;
      size: number;
      contentType: string;
      contentDisposition: string | null;
      contentId: string | null;
    }[];
    html: string | null;
    text: string | null;
    headers: {
      [key: string]: string;
    } | null;
    /** ISO 8601 datetime string. */
    occurredAt: string;
    scheduledAt: string | null;
    sentAt: string | null;
    lastEventType: string | null;
    lastEventAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
  }[];
  cursor?: string;
  hasNextPage: boolean;
  markdown: string;
};
type ResendListThreadsInput = {
  cursor?: string;
  pageSize?: number;
  order?: "asc" | "desc";
};
type ResendListThreadsOutput = {
  threads: {
    id: string;
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    messageCount: number;
    /** ISO 8601 datetime string. */
    firstMessageAt: string;
    /** ISO 8601 datetime string. */
    lastMessageAt: string;
    lastDirection: string | null;
    lastMessagePreview: string | null;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
  }[];
  cursor?: string;
  hasNextPage: boolean;
};
type ResendReplyToThreadInput = {
  threadId: string;
  subject?: string;
  body: string;
};
type ResendReplyToThreadOutput = {
  thread: {
    id: string;
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    messageCount: number;
    /** ISO 8601 datetime string. */
    firstMessageAt: string;
    /** ISO 8601 datetime string. */
    lastMessageAt: string;
    lastDirection: string | null;
    lastMessagePreview: string | null;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
    replyToAddress: string | null;
  };
  message: {
    id: string;
    threadId: string;
    direction: "inbound" | "outbound";
    status: string;
    from: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    providerEmailId: string | null;
    attachments: {
      id: string;
      filename: string | null;
      size: number;
      contentType: string;
      contentDisposition: string | null;
      contentId: string | null;
    }[];
    html: string | null;
    text: string | null;
    headers: {
      [key: string]: string;
    } | null;
    /** ISO 8601 datetime string. */
    occurredAt: string;
    scheduledAt: string | null;
    sentAt: string | null;
    lastEventType: string | null;
    lastEventAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
  };
};
