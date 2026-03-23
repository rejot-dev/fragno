import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type {
  ResendDomain,
  ResendDomainDetail,
  ResendEmailDetail,
  ResendEmailRecord,
  ResendEmailSummary,
  ResendListDomainsOutput,
  ResendListEmailsOutput,
  ResendListReceivedEmailsOutput,
  ResendListThreadMessagesOutput,
  ResendListThreadsOutput,
  ResendReceivedEmailDetail,
  ResendReceivedEmailSummary,
  ResendSendEmailInput,
  ResendThreadDetail,
  ResendThreadMessage,
  ResendThreadMutationOutput,
  ResendThreadReplyInput,
  ResendThreadSummary,
} from "@fragno-dev/resend-fragment";

import { getResendDurableObject } from "@/cloudflare/cloudflare-utils";
import type { ResendFragment } from "@/fragno/resend";

import type { ResendConfigState } from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type FragnoResponse<T> =
  | {
      type: "empty";
      status: number;
      headers: Headers;
    }
  | {
      type: "error";
      status: number;
      headers: Headers;
      error: { message: string; code: string };
    }
  | {
      type: "json";
      status: number;
      headers: Headers;
      data: T;
    }
  | {
      type: "jsonStream";
      status: number;
      headers: Headers;
      stream: AsyncGenerator<T extends unknown[] ? T[number] : T>;
    };

type ResendRouteInput<TBody = undefined> = {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Headers | Record<string, string>;
} & (TBody extends undefined ? { body?: never } : { body: TBody });

interface ResendRouteCaller {
  (
    method: "GET",
    path: "/domains",
    inputOptions?: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListDomainsOutput>>;
  (
    method: "GET",
    path: "/domains/:domainId",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendDomainDetail>>;
  (
    method: "POST",
    path: "/emails",
    inputOptions: ResendRouteInput<ResendSendEmailInput>,
  ): Promise<FragnoResponse<ResendEmailRecord>>;
  (
    method: "GET",
    path: "/emails",
    inputOptions?: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListEmailsOutput>>;
  (
    method: "GET",
    path: "/emails/:emailId",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendEmailDetail>>;
  (
    method: "GET",
    path: "/received-emails",
    inputOptions?: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListReceivedEmailsOutput>>;
  (
    method: "GET",
    path: "/received-emails/:emailId",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendReceivedEmailDetail>>;
  (
    method: "GET",
    path: "/threads",
    inputOptions?: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListThreadsOutput>>;
  (
    method: "GET",
    path: "/threads/:threadId",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendThreadDetail>>;
  (
    method: "GET",
    path: "/threads/:threadId/messages",
    inputOptions: ResendRouteInput,
  ): Promise<FragnoResponse<ResendListThreadMessagesOutput>>;
  (
    method: "POST",
    path: "/threads",
    inputOptions: ResendRouteInput<ResendSendEmailInput>,
  ): Promise<FragnoResponse<ResendThreadMutationOutput>>;
  (
    method: "POST",
    path: "/threads/:threadId/reply",
    inputOptions: ResendRouteInput<ResendThreadReplyInput>,
  ): Promise<FragnoResponse<ResendThreadMutationOutput>>;
}

const createResendRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): ResendRouteCaller => {
  const resendDo = getResendDurableObject(context, orgId);
  return createRouteCaller<ResendFragment>({
    baseUrl: request.url,
    mountRoute: "/api/resend",
    baseHeaders: request.headers,
    fetch: resendDo.fetch.bind(resendDo),
  }) as unknown as ResendRouteCaller;
};

type ResendConfigResult = {
  configState: ResendConfigState | null;
  configError: string | null;
};

type ResendDomainsResult = {
  domains: ResendDomain[];
  hasMore: boolean;
  domainsError: string | null;
};

type ResendDomainDetailResult = {
  domain: ResendDomainDetail | null;
  error: string | null;
};

type ResendOutboxResult = {
  emails: ResendEmailSummary[];
  cursor?: string;
  hasNextPage: boolean;
  outboxError: string | null;
};

type ResendSendEmailResult = {
  record: ResendEmailRecord | null;
  error: string | null;
};

type ResendEmailDetailResult = {
  email: ResendEmailDetail | null;
  error: string | null;
};

type ResendReceivedEmailsResult = {
  emails: ResendReceivedEmailSummary[];
  cursor?: string;
  hasNextPage: boolean;
  incomingError: string | null;
};

type ResendReceivedEmailDetailResult = {
  email: ResendReceivedEmailDetail | null;
  error: string | null;
};

type ResendThreadsResult = {
  threads: ResendThreadSummary[];
  cursor?: string;
  hasNextPage: boolean;
  threadsError: string | null;
};

type ResendThreadDetailResult = {
  thread: ResendThreadDetail | null;
  messages: ResendThreadMessage[];
  cursor?: string;
  hasNextPage: boolean;
  error: string | null;
};

type ResendCreateThreadResult = {
  result: ResendThreadMutationOutput | null;
  error: string | null;
};

type ResendReplyToThreadResult = {
  result: ResendThreadMutationOutput | null;
  error: string | null;
};

export async function fetchResendConfig(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<ResendConfigResult> {
  try {
    const resendDo = getResendDurableObject(context, orgId);
    const configState = await resendDo.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchResendDomains(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<ResendDomainsResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/domains");

    if (response.type === "json") {
      return {
        domains: response.data.domains ?? [],
        hasMore: response.data.hasMore ?? false,
        domainsError: null,
      };
    }

    if (response.type === "error") {
      if (response.error.code === "NOT_CONFIGURED") {
        return {
          domains: [],
          hasMore: false,
          domainsError: null,
        };
      }

      return {
        domains: [],
        hasMore: false,
        domainsError: response.error.message,
      };
    }

    return {
      domains: [],
      hasMore: false,
      domainsError: `Failed to fetch domains (${response.status}).`,
    };
  } catch (error) {
    return {
      domains: [],
      hasMore: false,
      domainsError: error instanceof Error ? error.message : "Failed to load domains.",
    };
  }
}

export async function fetchResendDomainDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  domainId: string,
): Promise<ResendDomainDetailResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/domains/:domainId", {
      pathParams: { domainId },
    });

    if (response.type === "json") {
      return { domain: response.data as ResendDomainDetail, error: null };
    }

    if (response.type === "error") {
      return { domain: null, error: response.error.message };
    }

    return {
      domain: null,
      error: `Failed to fetch domain (${response.status}).`,
    };
  } catch (error) {
    return {
      domain: null,
      error: error instanceof Error ? error.message : "Failed to load domain.",
    };
  }
}

export async function sendResendEmail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: ResendSendEmailInput,
): Promise<ResendSendEmailResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/emails", { body: payload });

    if (response.type === "json") {
      return { record: response.data as ResendEmailRecord, error: null };
    }

    if (response.type === "error") {
      return { record: null, error: response.error.message };
    }

    return {
      record: null,
      error: `Failed to send email (${response.status}).`,
    };
  } catch (error) {
    return {
      record: null,
      error: error instanceof Error ? error.message : "Failed to send email.",
    };
  }
}

export async function fetchResendEmailDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  emailId: string,
): Promise<ResendEmailDetailResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId },
    });

    if (response.type === "json") {
      return { email: response.data as ResendEmailDetail, error: null };
    }

    if (response.type === "error") {
      return { email: null, error: response.error.message };
    }

    return {
      email: null,
      error: `Failed to fetch email (${response.status}).`,
    };
  } catch (error) {
    return {
      email: null,
      error: error instanceof Error ? error.message : "Failed to load email.",
    };
  }
}

export async function fetchResendOutbox(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: {
    order?: "asc" | "desc";
    pageSize?: number;
    cursor?: string;
    status?: string;
  } = {},
): Promise<ResendOutboxResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const query: Record<string, string> = {
      order: options.order ?? "desc",
      pageSize: String(pageSize),
    };
    if (options.cursor) {
      query.cursor = options.cursor;
    }
    if (options.status) {
      query.status = options.status;
    }

    const response = await callRoute("GET", "/emails", { query });

    if (response.type === "json") {
      return {
        emails: response.data.emails ?? [],
        cursor: response.data.cursor,
        hasNextPage: response.data.hasNextPage ?? false,
        outboxError: null,
      };
    }

    if (response.type === "error") {
      return {
        emails: [],
        cursor: undefined,
        hasNextPage: false,
        outboxError: response.error.message,
      };
    }

    return {
      emails: [],
      cursor: undefined,
      hasNextPage: false,
      outboxError: `Failed to fetch outgoing emails (${response.status}).`,
    };
  } catch (error) {
    return {
      emails: [],
      cursor: undefined,
      hasNextPage: false,
      outboxError: error instanceof Error ? error.message : "Failed to load outgoing emails.",
    };
  }
}

export async function fetchResendReceivedEmails(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: {
    order?: "asc" | "desc";
    pageSize?: number;
    cursor?: string;
  } = {},
): Promise<ResendReceivedEmailsResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const query: Record<string, string> = {
      order: options.order ?? "desc",
      pageSize: String(pageSize),
    };

    if (options.cursor) {
      query.cursor = options.cursor;
    }

    const response = await callRoute("GET", "/received-emails", { query });

    if (response.type === "json") {
      return {
        emails: response.data.emails ?? [],
        cursor: response.data.cursor,
        hasNextPage: response.data.hasNextPage ?? false,
        incomingError: null,
      };
    }

    if (response.type === "error") {
      return {
        emails: [],
        cursor: undefined,
        hasNextPage: false,
        incomingError: response.error.message,
      };
    }

    return {
      emails: [],
      cursor: undefined,
      hasNextPage: false,
      incomingError: `Failed to fetch incoming emails (${response.status}).`,
    };
  } catch (error) {
    return {
      emails: [],
      cursor: undefined,
      hasNextPage: false,
      incomingError: error instanceof Error ? error.message : "Failed to load incoming emails.",
    };
  }
}

export async function fetchResendReceivedEmailDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  emailId: string,
): Promise<ResendReceivedEmailDetailResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/received-emails/:emailId", {
      pathParams: { emailId },
    });

    if (response.type === "json") {
      return { email: response.data as ResendReceivedEmailDetail, error: null };
    }

    if (response.type === "error") {
      return { email: null, error: response.error.message };
    }

    return {
      email: null,
      error: `Failed to fetch incoming email (${response.status}).`,
    };
  } catch (error) {
    return {
      email: null,
      error: error instanceof Error ? error.message : "Failed to load incoming email.",
    };
  }
}

export async function fetchResendThreads(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: {
    order?: "asc" | "desc";
    pageSize?: number;
    cursor?: string;
  } = {},
): Promise<ResendThreadsResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const query: Record<string, string> = {
      order: options.order ?? "desc",
      pageSize: String(pageSize),
    };

    if (options.cursor) {
      query.cursor = options.cursor;
    }

    const response = await callRoute("GET", "/threads", { query });

    if (response.type === "json") {
      return {
        threads: response.data.threads ?? [],
        cursor: response.data.cursor,
        hasNextPage: response.data.hasNextPage ?? false,
        threadsError: null,
      };
    }

    if (response.type === "error") {
      return {
        threads: [],
        cursor: undefined,
        hasNextPage: false,
        threadsError: response.error.message,
      };
    }

    return {
      threads: [],
      cursor: undefined,
      hasNextPage: false,
      threadsError: `Failed to fetch threads (${response.status}).`,
    };
  } catch (error) {
    return {
      threads: [],
      cursor: undefined,
      hasNextPage: false,
      threadsError: error instanceof Error ? error.message : "Failed to load threads.",
    };
  }
}

export async function fetchResendThreadDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  threadId: string,
  options: {
    order?: "asc" | "desc";
    pageSize?: number;
    cursor?: string;
  } = {},
): Promise<ResendThreadDetailResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : MAX_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const query: Record<string, string> = {
      order: options.order ?? "asc",
      pageSize: String(pageSize),
    };

    if (options.cursor) {
      query.cursor = options.cursor;
    }

    const [threadResponse, messagesResponse] = await Promise.all([
      callRoute("GET", "/threads/:threadId", {
        pathParams: { threadId },
      }),
      callRoute("GET", "/threads/:threadId/messages", {
        pathParams: { threadId },
        query,
      }),
    ]);

    const thread =
      threadResponse.type === "json" ? (threadResponse.data as ResendThreadDetail) : null;
    const messages = messagesResponse.type === "json" ? (messagesResponse.data.messages ?? []) : [];
    const cursor = messagesResponse.type === "json" ? messagesResponse.data.cursor : undefined;
    const hasNextPage =
      messagesResponse.type === "json" ? (messagesResponse.data.hasNextPage ?? false) : false;

    if (threadResponse.type === "json" && messagesResponse.type === "json") {
      return {
        thread,
        messages,
        cursor,
        hasNextPage,
        error: null,
      };
    }

    if (threadResponse.type === "error") {
      return {
        thread: null,
        messages: [],
        cursor: undefined,
        hasNextPage: false,
        error: threadResponse.error.message,
      };
    }

    if (messagesResponse.type === "error") {
      return {
        thread,
        messages: [],
        cursor: undefined,
        hasNextPage: false,
        error: messagesResponse.error.message,
      };
    }

    const failureStatus =
      threadResponse.type !== "json"
        ? threadResponse.status
        : messagesResponse.type !== "json"
          ? messagesResponse.status
          : 500;

    return {
      thread,
      messages,
      cursor,
      hasNextPage,
      error: `Failed to fetch thread (${failureStatus}).`,
    };
  } catch (error) {
    return {
      thread: null,
      messages: [],
      cursor: undefined,
      hasNextPage: false,
      error: error instanceof Error ? error.message : "Failed to load thread.",
    };
  }
}

export async function createResendThread(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: ResendSendEmailInput,
): Promise<ResendCreateThreadResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/threads", { body: payload });

    if (response.type === "json") {
      return {
        result: response.data as ResendThreadMutationOutput,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        result: null,
        error: response.error.message,
      };
    }

    return {
      result: null,
      error: `Failed to create thread (${response.status}).`,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Failed to create thread.",
    };
  }
}

export async function replyToResendThread(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  threadId: string,
  payload: ResendThreadReplyInput,
): Promise<ResendReplyToThreadResult> {
  try {
    const callRoute = createResendRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/threads/:threadId/reply", {
      pathParams: { threadId },
      body: payload,
    });

    if (response.type === "json") {
      return {
        result: response.data as ResendThreadMutationOutput,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        result: null,
        error: response.error.message,
      };
    }

    return {
      result: null,
      error: `Failed to send reply (${response.status}).`,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Failed to send reply.",
    };
  }
}
