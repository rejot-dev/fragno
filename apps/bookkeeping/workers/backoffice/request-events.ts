import {
  BackofficeApiRequestError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { RequestChange } from "../books/proposals/schema";
import { connectWithAppToken, requestAppToken } from "./client";
import { BOOKKEEPER_AGENT_NAME } from "./connection";
import { requestSubject } from "./proposal-requests";

/**
 * The events by which the books tell a firm what its bookkeeping agent is asked, in the firm's
 * agent project: one when a request is asked, and one when it ends. Their type's state keeps each
 * subject's latest: the subjects whose state says `requested` await the agent. The agent's package
 * starts a run of its request workflow for each request, which asks the agent.
 */
export const REQUEST_EVENT_TYPE = "proposal.changed";

/** What a `REQUEST_EVENT_TYPE` event says: `RequestChange` as the firm reads it. */
export type RequestEventPayload = {
  /** The subject a request is about, unique across the firm's clients' administrations. */
  subject: string;
  requestId: string;
  status: RequestChange["status"];
  /** What the agent is asked, for a request; null once it ended. */
  prompt: string | null;
  /** The document's file name or the bank transaction's description. */
  title: string;
  /** The client and administration whose books the subject is in. */
  client: string;
  administration: string;
};

/** How long a connection to a firm's agent project is reused: Backoffice rate-limits credentials. */
const CONNECTION_REUSE_MS = 60_000;

/**
 * Tells firms how the requests asked of their agents change, as the books' durable hook does after
 * each change commits. Each change is an event keyed by its request and status, so telling it again
 * after a failure fires it once, and it occurred when the change did, so a late one does not
 * overtake a later change of its subject. A failure throws, for the hook to try again.
 */
export function createFirmTeller(env: CloudflareEnv): (change: RequestChange) => Promise<void> {
  const connections = new Map<
    string,
    {
      until: number;
      connection: Promise<{ scope: BackofficeContextScope; backoffice: BackofficeApiClient }>;
    }
  >();

  async function connect(firmId: string) {
    const projectId = await env.DIRECTORY.getByName("directory").findFirmAgent(firmId);
    if (projectId === null) {
      throw new Error(`Firm ${firmId} has no bookkeeping agent to tell of its requests.`);
    }
    const scope = {
      kind: "project" as const,
      owner: { kind: "org" as const, orgId: firmId, jurisdiction: null },
      projectId,
    };
    const backoffice = await connectWithAppToken(env, await requestAppToken(env), scope);
    if (!backoffice) {
      throw new Error(`Bookkeeping is not installed for the bookkeeping agent of firm ${firmId}.`);
    }
    // The agent's package routes the events to runs asking the agent, so without the agent, as once
    // the firm removed the package, nobody would answer them: it is installed again, and the next
    // attempt tells.
    try {
      await backoffice.call(scope, "pi.agent.get", { agentName: BOOKKEEPER_AGENT_NAME });
    } catch (error) {
      if (error instanceof BackofficeApiRequestError && error.code === "not_found") {
        await env.DIRECTORY.getByName("directory").reinstallAgentPackage(projectId);
        throw new Error(`The bookkeeping agent of firm ${firmId} is being installed again.`);
      }
      throw error;
    }
    return { scope, backoffice };
  }

  function connection(firmId: string) {
    const reused = connections.get(firmId);
    if (reused && reused.until > Date.now()) {
      return reused.connection;
    }
    const connecting = connect(firmId);
    connections.set(firmId, { until: Date.now() + CONNECTION_REUSE_MS, connection: connecting });
    connecting.catch(() => {
      connections.delete(firmId);
    });
    return connecting;
  }

  return async function tellFirm(change) {
    const { scope, backoffice } = await connection(change.firmId);
    const payload: RequestEventPayload = {
      subject: requestSubject(change.requestId),
      requestId: change.requestId,
      status: change.status,
      prompt: change.prompt,
      ...change.about,
    };
    try {
      await backoffice.call(scope, "events.fire", {
        eventType: REQUEST_EVENT_TYPE,
        payload,
        idempotencyKey: `${change.requestId}:${change.status}`,
        occurredAt: change.at,
      });
    } catch (error) {
      // The credential may be what failed: the next attempt connects again.
      connections.delete(change.firmId);
      throw error;
    }
  };
}
