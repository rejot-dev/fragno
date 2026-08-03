import type {
  BrowserCreateResponse,
  BrowserDeleteResponse,
} from "cloudflare/resources/browser-rendering/devtools/browser/browser";
import type {
  TargetActivateResponse,
  TargetCloseResponse,
  TargetCreateResponse,
  TargetGetResponse,
  TargetListResponse,
} from "cloudflare/resources/browser-rendering/devtools/browser/targets";
import type {
  SessionGetResponse,
  SessionListResponse,
} from "cloudflare/resources/browser-rendering/devtools/session";

import type { CloudflareApiClient } from "../cloudflare-api";
import type {
  BrowserRunSessionCreateInput,
  BrowserRunSessionListInput,
  BrowserRunTargetCreateInput,
} from "./session-contracts";

export type BrowserRunSessions = {
  create(input?: BrowserRunSessionCreateInput): Promise<BrowserCreateResponse>;
  list(input?: BrowserRunSessionListInput): Promise<SessionListResponse>;
  get(sessionId: string): Promise<SessionGetResponse | null>;
  close(sessionId: string): Promise<BrowserDeleteResponse>;
  createTarget(
    sessionId: string,
    input?: BrowserRunTargetCreateInput,
  ): Promise<TargetCreateResponse>;
  listTargets(sessionId: string): Promise<TargetListResponse>;
  getTarget(sessionId: string, targetId: string): Promise<TargetGetResponse>;
  activateTarget(sessionId: string, targetId: string): Promise<TargetActivateResponse>;
  closeTarget(sessionId: string, targetId: string): Promise<TargetCloseResponse>;
};

export const createBrowserRunSessions = (
  cloudflare: CloudflareApiClient,
  accountId: string,
): BrowserRunSessions => ({
  create: (input = {}) =>
    cloudflare.browserRendering.devtools.browser.create({
      ...input,
      account_id: accountId,
    }),
  list: (input = {}) =>
    cloudflare.browserRendering.devtools.session.list({
      ...input,
      account_id: accountId,
    }),
  get: (sessionId) =>
    cloudflare.browserRendering.devtools.session.get(sessionId, {
      account_id: accountId,
    }),
  close: (sessionId) =>
    cloudflare.browserRendering.devtools.browser.delete(sessionId, {
      account_id: accountId,
    }),
  createTarget: (sessionId, input = {}) =>
    cloudflare.browserRendering.devtools.browser.targets.create(sessionId, {
      ...input,
      account_id: accountId,
    }),
  listTargets: (sessionId) =>
    cloudflare.browserRendering.devtools.browser.targets.list(sessionId, {
      account_id: accountId,
    }),
  getTarget: (sessionId, targetId) =>
    cloudflare.browserRendering.devtools.browser.targets.get(targetId, {
      account_id: accountId,
      session_id: sessionId,
    }),
  activateTarget: (sessionId, targetId) =>
    cloudflare.browserRendering.devtools.browser.targets.activate(targetId, {
      account_id: accountId,
      session_id: sessionId,
    }),
  closeTarget: (sessionId, targetId) =>
    cloudflare.browserRendering.devtools.browser.targets.close(targetId, {
      account_id: accountId,
      session_id: sessionId,
    }),
});
