import type { Route } from "./+types/home";
import { WelcomeShell, WelcomeHero, WelcomeExperiments } from "../welcome/welcome";
import { createChatnoClient } from "@rejot-dev/chatno";
import { useFragnoHooks } from "@rejot-dev/fragno/client/react";
import { useState } from "react";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno • Experimental" },
    { name: "description", content: "A beautiful experimental page for the Fragno library." },
  ];
}

const chatnoClient = createChatnoClient({});
const { useEcho, useAiConfig, useThing } = useFragnoHooks(chatnoClient);

export default function Home() {
  const [message, setMessage] = useState("Placeholder");

  const { data: echoData, loading: echoLoading } = useEcho({
    pathParams: {
      message,
    },
  });
  const { data: aiConfig, loading: aiConfigLoading } = useAiConfig();
  const { data: thing } = useThing({
    pathParams: {
      path: "hello",
    },
  });

  return (
    <WelcomeShell>
      <WelcomeHero />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-4 text-xl font-semibold">Live data</h2>

        <div className="mb-6">
          <label
            htmlFor="message-input"
            className="mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            Echo Message (React State)
          </label>
          <input
            id="message-input"
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            placeholder="Enter a message to echo..."
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">AI Config</h3>
            <div className="mt-2">
              {aiConfigLoading ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">Loading…</p>
              ) : (
                <pre className="max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
                  {JSON.stringify(aiConfig, null, 2)}
                </pre>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Echo</h3>
            <div className="mt-2">
              {echoLoading ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">Loading…</p>
              ) : (
                <p className="text-sm text-gray-700 dark:text-gray-200">
                  {echoData === undefined ? "—" : String(echoData)}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Thing</h3>
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
              {JSON.stringify(thing, null, 2)}
            </pre>
          </div>
        </div>
      </section>

      <WelcomeExperiments />
    </WelcomeShell>
  );
}
