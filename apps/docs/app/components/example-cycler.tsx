"use client";

import { useState } from "react";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { FlipWords } from "@/components/ui/flip-text";

const backendCode = `import { Hono } from "hono";
import { createCommentFragment } from "@/lib/comment-server";

const app = new Hono();
app.all("/api/comments/*", (c) => createCommentFragment().handler(c.req.raw));
`;

const frontendCode = `import { comments } from "@/lib/comment-client";

export default function CommentSection() {
  const { data: comments, loading, error } = comments.useComments();

  return <ul>
    {comments.map((comment) => (
      <li key={comment.id}>{comment.text}</li>
    ))}
  </ul>;
}`;

const words = ["payments", "AI Chat", "comments", "authentication"];
const CYCLE_DURATION = 3000;

export default function ExampleCycler({ className }: { className?: string }) {
  const [codeView, setCodeView] = useState<"backend" | "frontend">("backend");

  return (
    <section className={`mx-auto w-full max-w-7xl px-4 py-12 ${className}`}>
      <div className="mb-8">
        <h2 className="mb-4 text-3xl font-bold">
          It was never this easy to add
          <br /> [
          <FlipWords duration={CYCLE_DURATION} words={words} />]
        </h2>
      </div>
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-6 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-blue-400/25 via-transparent to-transparent blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-10 bottom-[-60px] h-40 w-56 rounded-full bg-gradient-to-br from-purple-400/20 via-transparent to-transparent blur-3xl"
        />

        <div className="bg-white/94 relative overflow-hidden rounded-[26px] p-4 shadow-[0_20px_40px_-35px_rgba(59,130,246,0.4)] transition-transform duration-500 dark:bg-slate-900/75">
          <div className="bg-white/92 flex flex-wrap gap-2 rounded-full p-1 dark:bg-slate-900/70">
            <button
              onClick={() => setCodeView("backend")}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                codeView === "backend"
                  ? "bg-gradient-to-r from-sky-500/80 via-blue-500/70 to-indigo-500/80 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-100/70 dark:hover:text-white"
              }`}
            >
              Backend
            </button>
            <button
              onClick={() => setCodeView("frontend")}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                codeView === "frontend"
                  ? "bg-gradient-to-r from-rose-500/80 via-fuchsia-500/70 to-purple-500/80 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-100/70 dark:hover:text-white"
              }`}
            >
              Frontend
            </button>
          </div>
          <div className="bg-white/97 relative mt-4 rounded-2xl p-3.5 text-left dark:bg-slate-950/60">
            <div className="relative overflow-hidden">
              <div
                className={`transition-all duration-500 ease-in-out ${
                  codeView === "backend"
                    ? "translate-x-0 opacity-100"
                    : "absolute inset-0 -translate-x-4 opacity-0"
                }`}
              >
                <DynamicCodeBlock lang="tsx" codeblock={{ allowCopy: false }} code={backendCode} />
              </div>
              <div
                className={`transition-all duration-500 ease-in-out ${
                  codeView === "frontend"
                    ? "translate-x-0 opacity-100"
                    : "absolute inset-0 translate-x-4 opacity-0"
                }`}
              >
                <DynamicCodeBlock lang="tsx" codeblock={{ allowCopy: false }} code={frontendCode} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
