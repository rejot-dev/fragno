import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";

import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import {
  DEFAULT_TELEGRAM_LINK_EXPIRY_MINUTES,
  OTP_LINK_TYPE,
  createOtpServer,
  type OtpFragment,
} from "@/fragno/otp";

const START_TOKEN_PREFIX = "otp-start:telegram-link:";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

type StoredTelegramLinkStartToken = {
  userId: string;
  code: string;
};

export type IssueTelegramLinkOtpInput = {
  userId: string;
  expiresInMinutes?: number;
};

export type IssueTelegramLinkOtpResult = {
  ok: true;
  userId: string;
  startToken: string;
};

export type ConsumeTelegramLinkOtpInput = {
  startToken: string;
};

export type ConsumeTelegramLinkOtpResult =
  | {
      ok: true;
      userId: string;
    }
  | {
      ok: false;
      error: "INVALID_START_TOKEN" | "OTP_INVALID" | "OTP_EXPIRED";
    };

const startTokenKey = (startToken: string) => `${START_TOKEN_PREFIX}${startToken}`;

const createStartToken = () => `tglnk_${crypto.randomUUID().replace(/-/g, "")}`;

const emptyQueue = {
  configured: true,
  hooksEnabled: false,
  namespace: null,
  items: [],
  cursor: undefined,
  hasNextPage: false,
} satisfies DurableHookQueueResponse;

export class Otp extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: OtpFragment | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
  }

  async #ensureFragment() {
    if (!this.#fragment) {
      this.#fragment = createOtpServer(this.#state);
      this.#migrated = false;
      this.#dispatcher = null;
    }

    if (!this.#migrated) {
      await migrate(this.#fragment);
      this.#migrated = true;
    }

    if (!this.#dispatcher) {
      try {
        const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
          onProcessError: (error) => {
            console.error("OTP hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("OTP hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return this.#fragment;
  }

  async issueTelegramLinkOtp(
    input: IssueTelegramLinkOtpInput,
  ): Promise<IssueTelegramLinkOtpResult> {
    const userId = input.userId.trim();
    if (!userId) {
      throw new Error("User id is required.");
    }

    const fragment = await this.#ensureFragment();
    const expiresInMinutes =
      typeof input.expiresInMinutes === "number" && Number.isFinite(input.expiresInMinutes)
        ? Math.max(1, Math.floor(input.expiresInMinutes))
        : DEFAULT_TELEGRAM_LINK_EXPIRY_MINUTES;

    const issued = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.otp.issueOtp(userId, OTP_LINK_TYPE, expiresInMinutes)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const startToken = createStartToken();
    const startRecord: StoredTelegramLinkStartToken = {
      userId: issued.userId,
      code: issued.code,
    };

    await this.#state.storage.put(startTokenKey(startToken), startRecord);

    return {
      ok: true,
      userId: issued.userId,
      startToken,
    };
  }

  async consumeTelegramLinkOtp(
    input: ConsumeTelegramLinkOtpInput,
  ): Promise<ConsumeTelegramLinkOtpResult> {
    const startToken = input.startToken.trim();
    if (!startToken) {
      return { ok: false, error: "INVALID_START_TOKEN" };
    }

    const fragment = await this.#ensureFragment();
    const key = startTokenKey(startToken);
    const startRecord = await this.#state.storage.get<StoredTelegramLinkStartToken>(key);
    if (!startRecord) {
      return { ok: false, error: "INVALID_START_TOKEN" };
    }

    const confirmation = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.otp.confirmOtp(startRecord.userId, startRecord.code, OTP_LINK_TYPE),
            ] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    if (!confirmation.confirmed) {
      await this.#state.storage.delete(key);
      return { ok: false, error: confirmation.error ?? "OTP_INVALID" };
    }

    await this.#state.storage.delete(key);

    return {
      ok: true,
      userId: startRecord.userId,
    };
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return emptyQueue;
    }

    return await loadDurableHookQueue(fragment, options);
  }

  async alarm(): Promise<void> {
    if (this.#dispatcher?.alarm) {
      await this.#dispatcher.alarm();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse({ message: "OTP is unavailable.", code: "NOT_CONFIGURED" }, 400);
    }

    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
