import { vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import {
  resendFragmentDefinition,
  type ResendEmailReceivedHookPayload,
  type ResendEmailStatusUpdatedHookPayload,
  type ResendFragmentConfig,
} from "./definition";
import {
  resendRoutesFactory,
  type ResendDomainDetail,
  type ResendListDomainsOutput,
  type ResendListEmailsOutput,
  type ResendEmailDetail,
  type ResendListReceivedEmailsOutput,
  type ResendReceivedEmailDetail,
  type ResendEmailRecord,
  type ResendListThreadMessagesOutput,
  type ResendListThreadsOutput,
  type ResendThreadDetail,
  type ResendThreadMutationOutput,
} from "./routes";
import type { ResendEmailMessageRow, ResendThreadRow } from "./routes/context";

type MockFn = ReturnType<typeof vi.fn>;
type OnEmailStatusUpdatedMock = MockFn &
  ((payload: ResendEmailStatusUpdatedHookPayload) => void | Promise<void>);
type OnEmailReceivedMock = MockFn &
  ((payload: ResendEmailReceivedHookPayload) => void | Promise<void>);

export const sendMock: MockFn = vi.fn();
export const verifyMock: MockFn = vi.fn();
export const domainsListMock: MockFn = vi.fn();
export const domainsGetMock: MockFn = vi.fn();
export const receivingListMock: MockFn = vi.fn();
export const receivingGetMock: MockFn = vi.fn();

vi.mock("resend", () => {
  class MockResend {
    domains = { list: domainsListMock, get: domainsGetMock };
    emails = {
      send: sendMock,
      receiving: {
        list: receivingListMock,
        get: receivingGetMock,
      },
    };
    webhooks = { verify: verifyMock };
  }

  return {
    Resend: vi.fn(function MockResendConstructor() {
      return new MockResend();
    }),
  };
});

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

type ResendTestRouteInput<TBody> = {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Headers | Record<string, string>;
} & (TBody extends undefined ? { body?: never } : { body: TBody });

interface ResendTestCallRoute {
  (
    method: "GET",
    path: "/domains",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendListDomainsOutput>>;
  (
    method: "GET",
    path: "/domains/:domainId",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendDomainDetail>>;
  (
    method: "GET",
    path: "/emails",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendListEmailsOutput>>;
  (
    method: "GET",
    path: "/emails/:emailId",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendEmailDetail>>;
  (
    method: "POST",
    path: "/emails",
    inputOptions: ResendTestRouteInput<unknown>,
  ): Promise<FragnoResponse<ResendEmailRecord>>;
  (
    method: "GET",
    path: "/received-emails",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendListReceivedEmailsOutput>>;
  (
    method: "GET",
    path: "/received-emails/:emailId",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendReceivedEmailDetail>>;
  (
    method: "GET",
    path: "/threads",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendListThreadsOutput>>;
  (
    method: "GET",
    path: "/threads/:threadId/messages",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendListThreadMessagesOutput>>;
  (
    method: "GET",
    path: "/threads/:threadId",
    inputOptions?: ResendTestRouteInput<undefined>,
  ): Promise<FragnoResponse<ResendThreadDetail>>;
  (
    method: "POST",
    path: "/threads",
    inputOptions: ResendTestRouteInput<unknown>,
  ): Promise<FragnoResponse<ResendThreadMutationOutput>>;
  (
    method: "POST",
    path: "/threads/:threadId/reply",
    inputOptions: ResendTestRouteInput<unknown>,
  ): Promise<FragnoResponse<ResendThreadMutationOutput>>;
}

export const createResendTestContext = async () => {
  const onEmailStatusUpdatedMock = vi.fn() as OnEmailStatusUpdatedMock;
  const onEmailReceivedMock = vi.fn() as OnEmailReceivedMock;

  const config: ResendFragmentConfig = {
    apiKey: "re_test",
    webhookSecret: "whsec_test",
    defaultFrom: "Acme <hello@example.com>",
    onEmailStatusUpdated: onEmailStatusUpdatedMock,
    onEmailReceived: onEmailReceivedMock,
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "resend",
      instantiate(resendFragmentDefinition).withConfig(config).withRoutes([resendRoutesFactory]),
    )
    .build();

  const fragment = fragments.resend.fragment;
  const callRoute = fragment.callRoute.bind(fragment) as unknown as ResendTestCallRoute;

  const reset = async () => {
    await testContext.resetDatabase();
    sendMock.mockReset();
    verifyMock.mockReset();
    domainsListMock.mockReset();
    domainsGetMock.mockReset();
    receivingListMock.mockReset();
    receivingGetMock.mockReset();
    onEmailStatusUpdatedMock.mockReset();
    onEmailReceivedMock.mockReset();
    config.defaultFrom = "Acme <hello@example.com>";
    config.webhookSecret = "whsec_test";
  };

  const cleanup = async () => {
    await testContext.cleanup();
  };

  const getEmail = (id: string): Promise<ResendEmailMessageRow | null> =>
    (async () => {
      const uow = fragments.resend.db
        .createUnitOfWork("read")
        .findFirst("emailMessage", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

  const getThread = (id: string): Promise<ResendThreadRow | null> =>
    (async () => {
      const uow = fragments.resend.db
        .createUnitOfWork("read")
        .findFirst("emailThread", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

  const getEmailByProviderId = (providerEmailId: string): Promise<ResendEmailMessageRow | null> =>
    (async () => {
      const uow = fragments.resend.db
        .createUnitOfWork("read")
        .findFirst("emailMessage", (b) =>
          b.whereIndex("idx_emailMessage_providerEmailId", (eb) =>
            eb("providerEmailId", "=", providerEmailId),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

  const listThreadMessages = (threadId: string) =>
    (async () => {
      const uow = fragments.resend.db
        .createUnitOfWork("read")
        .find("emailMessage", (b) =>
          b
            .whereIndex("idx_emailMessage_thread_occurredAt", (eb) => eb("threadId", "=", threadId))
            .orderByIndex("idx_emailMessage_thread_occurredAt", "asc"),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

  return {
    fragment,
    callRoute,
    onEmailStatusUpdated: onEmailStatusUpdatedMock,
    onEmailReceived: onEmailReceivedMock,
    db: fragments.resend.db,
    config,
    reset,
    cleanup,
    getEmail,
    getThread,
    getEmailByProviderId,
    listThreadMessages,
  };
};
