"use client";

import { createChatnoClient } from "@rejot-dev/chatno";
import { useFragno } from "@rejot-dev/fragno/client/react";
import { useState } from "react";

const chatnoClient = createChatnoClient({});
const { useEcho, useAiConfig, useThing, useEchoMutator } = useFragno(chatnoClient);

export default function Home() {
  // State for reading messages
  const [messageKey, setMessageKey] = useState("default");
  const [capital, setCapital] = useState(false);

  // State for writing messages
  const [newMessageKey, setNewMessageKey] = useState("default");
  const [newMessage, setNewMessage] = useState("Hello World");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const { data: echoData, loading: echoLoading } = useEcho({
    pathParams: {
      message: messageKey,
    },
    queryParams: {
      capital: String(capital),
    },
  });
  const { data: aiConfig, loading: aiConfigLoading } = useAiConfig();
  const { data: thing } = useThing({
    pathParams: {
      path: "hello",
    },
  });

  const echoMutator = useEchoMutator;

  const handleSubmitMessage = async () => {
    if (!newMessage.trim() || !newMessageKey.trim()) return;

    setIsSubmitting(true);
    setSubmitResult(null);

    try {
      const result = await echoMutator(
        { message: newMessage },
        {
          pathParams: {
            messageKey: newMessageKey,
          },
        },
      );
      setSubmitResult(`Message saved! Previous: "${result.previous || "none"}"`);
      // Update the read section to show the newly created/updated message
      setMessageKey(newMessageKey);
    } catch (error) {
      setSubmitResult(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Next.js Fragno/Chatno Integration Test</h1>
      <p>API routes are mounted at: /api/chatno</p>
      <ul>
        <li>GET /api/chatno/ - Hello World</li>
        <li>GET /api/chatno/echo/:message - Echo stored message</li>
        <li>PUT /api/chatno/echo/:messageKey - Store a message</li>
        <li>GET /api/chatno/ai-config - Get AI config</li>
        <li>GET /api/chatno/thing/**:path - Wildcard route test</li>
      </ul>
      <h2>Write/Update Messages</h2>
      <div>
        <label>Message Key:</label>
        <input
          type="text"
          value={newMessageKey}
          onChange={(e) => setNewMessageKey(e.target.value)}
          placeholder="Enter a key for the message..."
        />
      </div>
      <div>
        <label>Message Content:</label>
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Enter the message content..."
        />
      </div>
      <button
        onClick={handleSubmitMessage}
        disabled={isSubmitting || !newMessage.trim() || !newMessageKey.trim()}
      >
        {isSubmitting ? "Saving..." : "Save Message"}
      </button>
      {submitResult && <div>{submitResult}</div>}

      <h2>Read Messages</h2>
      <div>
        <label>Message Key to Read:</label>
        <input
          type="text"
          value={messageKey}
          onChange={(e) => setMessageKey(e.target.value)}
          placeholder="Enter a message key to read..."
        />
        <label>
          <input type="checkbox" checked={capital} onChange={(e) => setCapital(e.target.checked)} />
          Capitalize
        </label>
      </div>
      <div>
        <strong>Message Content:</strong>
        {echoLoading ? <p>Loading…</p> : <p>{echoData === undefined ? "—" : String(echoData)}</p>}
      </div>

      <h2>Other Live Data</h2>
      <div>
        <h3>AI Config</h3>
        {aiConfigLoading ? <p>Loading…</p> : <pre>{JSON.stringify(aiConfig, null, 2)}</pre>}
      </div>
      <div>
        <h3>Thing</h3>
        <pre>{JSON.stringify(thing, null, 2)}</pre>
      </div>
    </div>
  );
}
