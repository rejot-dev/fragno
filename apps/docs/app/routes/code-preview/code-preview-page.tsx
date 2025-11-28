import { ThemeToggle } from "fumadocs-ui/components/layout/theme-toggle";
import { useState } from "react";
import { Grid2x2, Grid3x3, Square, LayoutGrid, ChevronLeft, ChevronRight } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function loader() {
  // Only allow access in development mode
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
}

type LayoutMode = "single" | "dual" | "triple" | "quad";

interface LayoutConfig {
  mode: LayoutMode;
  label: string;
  icon: typeof Square;
  count: number;
  width: number;
  height: number;
}

const layoutConfigs: LayoutConfig[] = [
  {
    mode: "single",
    label: "1 Image",
    icon: Square,
    count: 1,
    width: 1200,
    height: 675,
  },
  {
    mode: "dual",
    label: "2 Images",
    icon: Grid2x2,
    count: 2,
    width: 700,
    height: 800,
  },
  {
    mode: "triple",
    label: "3 Images",
    icon: Grid3x3,
    count: 3,
    width: 700,
    height: 800,
  },
  {
    mode: "quad",
    label: "4 Images",
    icon: LayoutGrid,
    count: 4,
    width: 1200,
    height: 600,
  },
];

const defaultCode = `import { createFragment } from '@fragno-dev/core';

export const myFragment = createFragment({
  name: 'my-fragment',
  routes: {
    hello: {
      path: '/hello',
      method: 'GET',
      handler: async () => {
        return { message: 'Hello from Fragno!' };
      },
    },
  },
  client: (builder) => ({
    useGreeting: builder.createQuery({
      route: 'hello',
      queryKey: ['greeting'],
    }),
  }),
});`;

const defaultDescription =
  "A simple fragment example showing how to define routes and client hooks with Fragno.";

export default function CodePreviewPage() {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("single");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [description, setDescription] = useState(defaultDescription);
  const [code, setCode] = useState(defaultCode);
  const [language, setLanguage] = useState("typescript");

  const currentLayout =
    layoutConfigs.find((config) => config.mode === layoutMode) || layoutConfigs[0];

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      {/* Controls - Top Right */}
      <div className="absolute right-4 top-4 z-20 flex flex-col gap-3">
        <ThemeToggle />

        {/* Layout Mode Toggle */}
        <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/95">
          <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-slate-600 dark:text-slate-400">
            <LayoutGrid className="h-3 w-3" />
            Layout Mode
          </div>
          {layoutConfigs.map((config) => {
            const Icon = config.icon;
            return (
              <button
                key={config.mode}
                onClick={() => {
                  setLayoutMode(config.mode);
                  setCurrentIndex(0);
                }}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ${
                  layoutMode === config.mode
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted/50 text-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5" />
                  {config.label}
                </div>
                <div className="text-xs opacity-70">
                  {config.width}×{config.height}
                </div>
              </button>
            );
          })}
        </div>

        {/* Image Selector (only show if count > 1) */}
        {currentLayout.count > 1 && (
          <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/95">
            <div className="mb-2 px-1 text-xs font-semibold text-slate-600 dark:text-slate-400">
              Current Image
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                disabled={currentIndex === 0}
                className="rounded-lg p-2 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-slate-700"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="text-sm font-semibold">
                {currentIndex + 1} of {currentLayout.count}
              </div>
              <button
                onClick={() => setCurrentIndex(Math.min(currentLayout.count - 1, currentIndex + 1))}
                disabled={currentIndex === currentLayout.count - 1}
                className="rounded-lg p-2 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-slate-700"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Screenshot Area - Centered */}
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-8">
          {/* The element to screenshot */}
          <div
            className="shadow-2xl"
            style={{
              width: `${currentLayout.width}px`,
              height: `${currentLayout.height}px`,
            }}
          >
            <div className="flex h-full flex-col overflow-hidden rounded-xl border-2 border-slate-300 bg-gradient-to-br from-slate-50 to-white dark:border-slate-600 dark:from-slate-800/50 dark:to-slate-900/50">
              {/* Description Section */}
              <div className="border-b border-slate-200 bg-gradient-to-br from-blue-50/50 to-purple-50/30 px-8 py-6 dark:border-slate-700 dark:from-blue-950/30 dark:to-purple-950/20">
                <p className="text-lg font-medium leading-relaxed text-slate-700 dark:text-slate-200">
                  {description}
                </p>
              </div>

              {/* Code Section */}
              <div className="flex-1 overflow-hidden">
                <div className="bg-slate-100/80 px-6 py-3 dark:bg-slate-800/50">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="h-3 w-3 rounded-full bg-red-400" />
                      <div className="h-3 w-3 rounded-full bg-yellow-400" />
                      <div className="h-3 w-3 rounded-full bg-green-400" />
                    </div>
                    <div className="ml-2 text-sm font-medium text-slate-600 dark:text-slate-400">
                      {language}
                    </div>
                  </div>
                </div>
                <div
                  className="code-preview-container overflow-auto"
                  style={{
                    height: `${currentLayout.height - 135}px`,
                  }}
                >
                  <style
                    dangerouslySetInnerHTML={{
                      __html: `.code-preview-container pre, .code-preview-container code, .code-preview-container figure { background: transparent !important; padding-top: 0 !important; border: none !important; } .code-preview-container code { font-size: 0.95rem !important; line-height: 1.6 !important; }`,
                    }}
                  />
                  <FragnoCodeBlock
                    lang={language}
                    code={code}
                    codeblock={{
                      allowCopy: false,
                    }}
                    options={{
                      defaultColor: false,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Input Controls Below */}
          <div
            className="w-full space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-slate-800"
            style={{
              width: `${currentLayout.width}px`,
            }}
          >
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-300">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                placeholder="Enter description..."
              />
            </div>

            <div className="grid grid-cols-[1fr_150px] gap-4">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-300">
                  Code
                </label>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={15}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 font-mono text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                  placeholder="Enter code..."
                  spellCheck={false}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-300">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                >
                  <option value="typescript">TypeScript</option>
                  <option value="tsx">TSX</option>
                  <option value="javascript">JavaScript</option>
                  <option value="jsx">JSX</option>
                  <option value="json">JSON</option>
                  <option value="bash">Bash</option>
                  <option value="shell">Shell</option>
                  <option value="css">CSS</option>
                  <option value="html">HTML</option>
                  <option value="markdown">Markdown</option>
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
              <strong>📸 Screenshot tip:</strong> Use your browser's screenshot tool to capture just
              the code preview element above.
              {currentLayout.count > 1 &&
                ` Create ${currentLayout.count} separate screenshots for your multi-image post.`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
