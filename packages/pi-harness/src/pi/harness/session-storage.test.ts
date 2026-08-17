import { describe, expect, it, assert } from "vitest";

import {
  AgentHarness,
  Session,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

import {
  createWorkflowBackedSessionEntryIdAllocator,
  WorkflowBackedSessionStorage,
} from "./session-storage";
import { createModelsForStreamFn, mockAgentHarnessCompaction } from "./test-models";

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
  it("keeps original retained-tail entries visible for repeated compaction", async () => {
    const firstUser = userMessage("first prompt");
    const firstAssistant = assistantMessage("first reply");
    const secondUser = userMessage("second prompt");
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-06-24T00:00:00.000Z",
        message: firstUser,
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-06-24T00:00:01.000Z",
        message: firstAssistant,
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp: "2026-06-24T00:00:02.000Z",
        summary: "Earlier context",
        firstKeptEntryId: "user-1",
        tokensBefore: 10_000,
        retainedTail: [firstUser, firstAssistant],
        fromHook: false,
      },
      {
        type: "message",
        id: "user-2",
        parentId: "compaction-1",
        timestamp: "2026-06-24T00:00:03.000Z",
        message: secondUser,
      },
    ];
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries,
      entryIds: entryIds("next"),
    });

    await expect(storage.getPathToRootOrCompaction("user-2")).resolves.toMatchObject([
      { id: "user-1" },
      { id: "assistant-1" },
      { id: "compaction-1" },
      { id: "user-2" },
    ]);

    const context = await new Session(storage).buildContext();
    expect(context.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("feeds a previous retained tail into the next compaction preparation", async () => {
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entryIds: entryIds("repeated-compaction"),
    });
    const session = new Session(storage);
    const summarizationPrompts: string[] = [];
    const summarizationStream = createTextStreamFn("Second compacted history");
    const models = createModelsForStreamFn(mockModel, (_model, context, _options) => {
      summarizationPrompts.push(
        context.messages
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((content) =>
                  content.type === "text" ? [content.text] : [],
                ),
          )
          .join("\n"),
      );
      return summarizationStream();
    });
    const harness = new AgentHarness({ session, models, model: mockModel });

    for (let turn = 0; turn < 10; turn += 1) {
      await harness.appendMessage(userMessage(`initial-turn-${turn}:${"x".repeat(9_000)}`));
      await harness.appendMessage(assistantMessage(`initial-response-${turn}`));
    }

    const unsubscribeFirstMock = mockAgentHarnessCompaction(harness, {
      summary: "First compacted history",
    });
    const firstResult = await harness.compact();
    unsubscribeFirstMock();
    const firstRetainedTail = firstResult.retainedTail ?? [];
    expect(firstRetainedTail.length).toBeGreaterThan(0);
    const previousRetainedMarker = messageText(firstRetainedTail[0] as AgentMessage).slice(0, 20);

    for (let turn = 0; turn < 5; turn += 1) {
      await harness.appendMessage(userMessage(`later-turn-${turn}:${"y".repeat(9_000)}`));
      await harness.appendMessage(assistantMessage(`later-response-${turn}`));
    }

    const secondResult = await harness.compact();

    expect(summarizationPrompts).toHaveLength(1);
    expect(summarizationPrompts[0]).toContain(previousRetainedMarker);
    expect(summarizationPrompts[0]).toContain("First compacted history");
    assert(secondResult.summary === "Second compacted history");
    expect(secondResult.firstKeptEntryId).not.toBe(firstResult.firstKeptEntryId);

    const context = await session.buildContext();
    expect(context.messages[0]).toMatchObject({
      role: "compactionSummary",
      summary: "Second compacted history",
    });
    expect(context.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.anything() }),
      ]),
    );
  });

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

  it("rejects a duplicate entry id without replacing the existing entry", async () => {
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entryIds: entryIds("duplicate"),
    });
    const original: SessionTreeEntry = {
      type: "message",
      id: "duplicate-entry",
      parentId: null,
      timestamp: "2026-06-24T00:00:01.000Z",
      message: userMessage("original"),
    };

    await storage.appendEntry(original);

    await expect(
      storage.appendEntry({
        ...original,
        message: userMessage("replacement"),
      }),
    ).rejects.toThrow("Entry duplicate-entry already exists");
    await expect(storage.getEntries()).resolves.toEqual([original]);
    await expect(storage.getLeafId()).resolves.toBe("duplicate-entry");
  });

  it("reads entry pages using Pi session cursor semantics", async () => {
    const entries: SessionTreeEntry[] = ["first", "second", "third"].map((id, index) => ({
      type: "custom",
      id,
      parentId: index === 0 ? null : ["first", "second"][index - 1]!,
      timestamp: `2026-06-24T00:00:0${index + 1}.000Z`,
      customType: "test",
    }));
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries,
      entryIds: entryIds("cursor"),
    });

    await expect(storage.getEntries({ afterEntrySeq: 1, limit: 1 })).resolves.toMatchObject([
      { id: "second" },
    ]);
    await expect(storage.getEntries({ afterEntrySeq: 2 })).resolves.toMatchObject([
      { id: "third" },
    ]);
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
      model: mockModel,
      models: createModelsForStreamFn(mockModel, createTextStreamFn("unused")),
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
    const proofStream = createTextStreamFn("stop");
    const harness = new AgentHarness({
      model: mockModel,
      models: createModelsForStreamFn(mockModel, proofStream),
      session,
    });

    const before = await prettySession(storage, appended);
    const result = await harness.navigateTree("parent-entry");
    await harness.prompt("hello");
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
