import { describe, expect, it } from "vitest";

import {
  AgentHarness,
  Session,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";

import { NoOpExecutionEnv } from "./execution-env";
import {
  createWorkflowBackedSessionEntryIdAllocator,
  WorkflowBackedSessionStorage,
} from "./session-storage";

const metadata = { id: "session-1", createdAt: "2026-06-24T00:00:00.000Z" };
const entryIds = (prefix: string, startIndex = 0) =>
  createWorkflowBackedSessionEntryIdAllocator({ prefix, startIndex });

const mockModel: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

const userMessage = (text: string): AgentMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }) as AgentMessage;

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: mockModel.api,
  provider: mockModel.provider,
  model: mockModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const createTextStreamFn = (text: string) => () => {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(text);

  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });

  return stream;
};

const messageText = (message: AgentMessage): string => {
  if (!("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((content) => (content.type === "text" ? content.text : `[${content.type}]`))
    .join("");
};

const prettySession = async (
  storage: WorkflowBackedSessionStorage,
  appended: readonly SessionTreeEntry[],
): Promise<string> => {
  const entries = await storage.getEntries();
  const leafId = await storage.getLeafId();
  const formatEntry = (entry: SessionTreeEntry): string => {
    if (entry.type === "message") {
      return `- ${entry.type}:${entry.id} parent=${entry.parentId ?? "null"} role=${entry.message.role} text=${messageText(entry.message)}`;
    }
    if (entry.type === "leaf") {
      return `- ${entry.type}:${entry.id} parent=${entry.parentId ?? "null"} target=${entry.targetId ?? "null"}`;
    }
    return `- ${entry.type}:${entry.id} parent=${entry.parentId ?? "null"}`;
  };

  return [
    `leafId: ${leafId ?? "null"}`,
    "entries:",
    ...entries.map(formatEntry),
    "appended:",
    ...(appended.length === 0 ? ["- <none>"] : appended.map(formatEntry)),
  ].join("\n");
};

describe("WorkflowBackedSessionStorage", () => {
  it("appends message entries and exposes the active path", async () => {
    const appended: SessionTreeEntry[] = [];
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entryIds: entryIds("turn-1"),
      onAppendEntry: (entry) => {
        appended.push(entry);
      },
    });

    const firstId = await storage.createEntryId();
    await storage.appendEntry({
      type: "message",
      id: firstId,
      parentId: null,
      timestamp: "2026-06-24T00:00:01.000Z",
      message: userMessage("hello"),
    });

    const secondId = await storage.createEntryId();
    await storage.appendEntry({
      type: "message",
      id: secondId,
      parentId: firstId,
      timestamp: "2026-06-24T00:00:02.000Z",
      message: userMessage("again"),
    });

    await expect(storage.getLeafId()).resolves.toBe(secondId);
    await expect(storage.getPathToRoot(secondId)).resolves.toMatchObject([
      { id: firstId, type: "message" },
      { id: secondId, type: "message" },
    ]);
    expect(appended.map((entry) => entry.id)).toEqual([firstId, secondId]);
  });

  it("records leaf moves as durable leaf entries", async () => {
    const storage = new WorkflowBackedSessionStorage({ metadata, entryIds: entryIds("leaf") });
    await storage.appendEntry({
      type: "custom",
      id: "root-entry",
      parentId: null,
      timestamp: "2026-06-24T00:00:01.000Z",
      customType: "root",
    });

    await storage.setLeafId(null);

    await expect(storage.getLeafId()).resolves.toBeNull();
    await expect(storage.findEntries("leaf")).resolves.toMatchObject([
      { type: "leaf", parentId: "root-entry", targetId: null },
    ]);
  });

  it("shows navigateTree short-circuits when the target user entry is already the leaf", async () => {
    const appended: SessionTreeEntry[] = [];
    const userEntry: SessionTreeEntry = {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: "2026-06-24T00:00:01.000Z",
      message: userMessage("hello"),
    };
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries: [userEntry],
      entryIds: entryIds("proof"),
      onAppendEntry: (entry) => {
        appended.push(entry);
      },
    });
    const session = new Session(storage);
    const harness = new AgentHarness({
      env: new NoOpExecutionEnv(),
      model: mockModel,
      session,
    });

    const before = await prettySession(storage, appended);
    const result = await harness.navigateTree("user-entry");
    const after = await prettySession(storage, appended);
    const proof = [
      "before navigateTree(user-entry):",
      before,
      `navigateTree result: ${JSON.stringify(result)}`,
      "after navigateTree(user-entry):",
      after,
    ].join("\n");

    console.info(proof);

    expect(proof).toBe(`before navigateTree(user-entry):
leafId: user-entry
entries:
- message:user-entry parent=null role=user text=hello
appended:
- <none>
navigateTree result: {"cancelled":false}
after navigateTree(user-entry):
leafId: user-entry
entries:
- message:user-entry parent=null role=user text=hello
appended:
- <none>`);
  });

  it("can navigate to the parent and prompt the same text as a new active branch", async () => {
    const appended: SessionTreeEntry[] = [];
    const parentEntry: SessionTreeEntry = {
      type: "message",
      id: "parent-entry",
      parentId: null,
      timestamp: "2026-06-24T00:00:00.000Z",
      message: assistantMessage("before"),
    };
    const staleUserEntry: SessionTreeEntry = {
      type: "message",
      id: "stale-user-entry",
      parentId: "parent-entry",
      timestamp: "2026-06-24T00:00:01.000Z",
      message: userMessage("hello"),
    };
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries: [parentEntry, staleUserEntry],
      entryIds: entryIds("proof-parent"),
      onAppendEntry: (entry) => {
        appended.push(entry);
      },
    });
    const session = new Session(storage);
    const sourceId = "session-storage-proof-provider";
    const proofStream = createTextStreamFn("stop");
    registerApiProvider(
      {
        api: mockModel.api,
        stream: proofStream as unknown as (
          model: Model<Api>,
          context: Context,
          options?: StreamOptions,
        ) => AssistantMessageEventStream,
        streamSimple: proofStream as unknown as (
          model: Model<Api>,
          context: Context,
          options?: SimpleStreamOptions,
        ) => AssistantMessageEventStream,
      },
      sourceId,
    );
    const harness = new AgentHarness({
      env: new NoOpExecutionEnv(),
      model: mockModel,
      session,
    });

    const before = await prettySession(storage, appended);
    const result = await harness.navigateTree("parent-entry");
    await harness.prompt("hello");
    unregisterApiProviders(sourceId);
    const after = await prettySession(storage, appended);
    const activeMessages = (await session.buildContext()).messages.map(
      (message) => `${message.role}:${messageText(message)}`,
    );
    const proof = [
      "before navigateTree(parent-entry) + prompt(hello):",
      before,
      `navigateTree result: ${JSON.stringify(result)}`,
      "after navigateTree(parent-entry) + prompt(hello):",
      after,
      `active messages: ${JSON.stringify(activeMessages)}`,
    ].join("\n");

    console.info(proof);

    expect(proof).toBe(`before navigateTree(parent-entry) + prompt(hello):
leafId: stale-user-entry
entries:
- message:parent-entry parent=null role=assistant text=before
- message:stale-user-entry parent=parent-entry role=user text=hello
appended:
- <none>
navigateTree result: {"cancelled":false}
after navigateTree(parent-entry) + prompt(hello):
leafId: proof-parent-2
entries:
- message:parent-entry parent=null role=assistant text=before
- message:stale-user-entry parent=parent-entry role=user text=hello
- leaf:proof-parent-0 parent=stale-user-entry target=parent-entry
- message:proof-parent-1 parent=parent-entry role=user text=hello
- message:proof-parent-2 parent=proof-parent-1 role=assistant text=stop
appended:
- leaf:proof-parent-0 parent=stale-user-entry target=parent-entry
- message:proof-parent-1 parent=parent-entry role=user text=hello
- message:proof-parent-2 parent=proof-parent-1 role=assistant text=stop
active messages: ["assistant:before","user:hello","assistant:stop"]`);
  });

  it("builds label state from label entries", async () => {
    const storage = new WorkflowBackedSessionStorage({ metadata, entryIds: entryIds("labels") });
    await storage.appendEntry({
      type: "custom",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-06-24T00:00:01.000Z",
      customType: "target",
    });
    await storage.appendEntry({
      type: "label",
      id: "label-1",
      parentId: "entry-1",
      timestamp: "2026-06-24T00:00:02.000Z",
      targetId: "entry-1",
      label: "Important",
    });

    await expect(storage.getLabel("entry-1")).resolves.toBe("Important");
  });
});
