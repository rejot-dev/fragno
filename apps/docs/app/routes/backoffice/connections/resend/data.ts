import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type {
  ResendDomain,
  ResendDomainDetail,
  ResendEmailDetail,
  ResendEmailRecord,
  ResendEmailSummary,
  ResendSendEmailInput,
} from "@fragno-dev/resend-fragment";

import { getResendDurableObject } from "@/cloudflare/cloudflare-utils";
import type { ResendFragment } from "@/fragno/resend";

import type { ResendConfigState } from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const createResendRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const resendDo = getResendDurableObject(context, orgId);
  return createRouteCaller<ResendFragment>({
    baseUrl: request.url,
    mountRoute: "/api/resend",
    baseHeaders: request.headers,
    fetch: resendDo.fetch.bind(resendDo),
  });
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
      outboxError: `Failed to fetch outbox (${response.status}).`,
    };
  } catch (error) {
    return {
      emails: [],
      cursor: undefined,
      hasNextPage: false,
      outboxError: error instanceof Error ? error.message : "Failed to load outbox.",
    };
  }
}
