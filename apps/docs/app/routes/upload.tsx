import { Database, FolderUp, Search, Terminal, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function meta() {
  return [
    { title: "Upload Fragment" },
    {
      name: "description",
      content:
        "Database-backed file storage with atomic writes, batch publication, search, and progress tracking.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

type Step = {
  title: string;
  description: string;
  lang: "bash" | "ts";
  code: string;
};

const features: Feature[] = [
  {
    title: "File + upload model",
    description: "Track upload lifecycle and file metadata with durable records.",
    icon: <Database className="size-5" />,
  },
  {
    title: "Atomic writes",
    description: "A file's content and metadata commit in the same database transaction.",
    icon: <Upload className="size-5" />,
  },
  {
    title: "Search and edits",
    description: "Text search, server-side edits, and signed file links over stored files.",
    icon: <Search className="size-5" />,
  },
];

const setupSteps: Step[] = [
  {
    title: "1. Install",
    description: "Install the upload fragment.",
    lang: "bash",
    code: "npm install @fragno-dev/upload",
  },
  {
    title: "2. Create the fragment server",
    description: "Set the largest file and mount the routes.",
    lang: "ts",
    code: `import { createUploadFragment } from "@fragno-dev/upload";
import { migrate } from "@fragno-dev/db";

const fragment = createUploadFragment(
  { maxFileBytes: 10 * 1024 * 1024 },
  {
    databaseAdapter,
    mountRoute: "/api/uploads",
  },
);

await migrate(fragment);`,
  },
  {
    title: "3. Create a client",
    description: "Generate typed hooks and upload helpers.",
    lang: "ts",
    code: `import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export const uploadClient = createUploadFragmentClient({
  mountRoute: "/api/uploads",
});`,
  },
];

const usageSnippet = `const { useUploadHelpers } = uploadClient;

const helpers = useUploadHelpers();
await helpers.createUploadAndTransfer(file, {
  fileKey: \`users/\${userId}/avatar.png\`,
  onProgress: (progress) => {
    console.log(progress.bytesUploaded, progress.totalBytes);
  },
});`;

const cliSnippet = `fragno-upload uploads create -b https://host/api/uploads \\
  --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain

fragno-upload uploads transfer -b https://host/api/uploads -f ./demo.txt --file-key s~Zm9v

fragno-upload files list -b https://host/api/uploads --prefix s~Zm9v

fragno-upload files download -b https://host/api/uploads --file-key s~Zm9v -o ./download.txt`;

const useCases = [
  {
    title: "Profile avatars",
    description: "Upload user images with a predictable file key and progress tracking.",
  },
  {
    title: "Agent workspaces",
    description: "Let agents search, edit, and atomically rewrite sets of files.",
  },
  {
    title: "Multi-tenant files",
    description: "Keep each tenant's files under its own key prefix.",
  },
];

export default function UploadPage() {
  return (
    <main className="relative min-h-screen">
      <div className="mx-auto max-w-7xl space-y-14 px-4 py-16 md:px-8">
        <FragmentSubnav current="upload" />
        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-5">
            <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
              File Uploads
            </h1>
            <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
              Files stored in your database, with atomic writes, batch publication, and search.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                to="/docs/upload/overview"
                className="rounded-lg bg-cyan-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-cyan-700"
              >
                Upload Docs
              </Link>
            </div>
            <div className="max-w-md space-y-2 pt-3">
              <p className="text-fd-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Install
              </p>
              <FragnoCodeBlock
                lang="bash"
                code="npm install @fragno-dev/upload"
                allowCopy
                className="rounded-xl"
              />
              <p className="text-fd-muted-foreground text-xs">
                Requires a Fragno database adapter, which stores files and their content.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/30 text-cyan-600 dark:text-cyan-300">
                <FolderUp className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Publishing files
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  Publish each upload on its own, or several together.
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4">
              <div className="rounded-xl border border-black/5 p-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Immediate</p>
                <p className="text-fd-muted-foreground text-sm">
                  Storing an upload's content publishes the file in the same transaction.
                </p>
              </div>
              <div className="rounded-xl border border-black/5 p-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Batch</p>
                <p className="text-fd-muted-foreground text-sm">
                  Prepare several uploads, then publish them all in one commit.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 text-cyan-600 dark:text-cyan-300">
                  {feature.icon}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {feature.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 text-cyan-600 dark:text-cyan-300">
              <FolderUp className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Setup blueprint
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                Mount the routes and ship upload flows.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-6">
              {setupSteps.map((step) => (
                <div
                  key={step.title}
                  className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
                >
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {step.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{step.description}</p>
                  <div className="mt-4">
                    <FragnoCodeBlock
                      lang={step.lang}
                      code={step.code}
                      allowCopy
                      className="rounded-xl"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Use it</h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  The client helper creates the upload, streams its content, and reports progress.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock lang="ts" code={usageSnippet} allowCopy className="rounded-xl" />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Large files
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Files live in database rows, so keep them within your database's limits. Keep
                  recordings, videos, and other large files in S3-compatible object storage with the{" "}
                  <code>@fragno-dev/blobs</code> fragment instead.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 text-cyan-600 dark:text-cyan-300">
              <Terminal className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Upload CLI</h2>
              <p className="text-fd-muted-foreground text-sm">
                Manage upload sessions and files with `fragno-upload`.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <FragnoCodeBlock lang="bash" code={cliSnippet} allowCopy className="rounded-xl" />
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Use cases</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {useCases.map((useCase) => (
              <div
                key={useCase.title}
                className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
              >
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {useCase.title}
                </h3>
                <p className="text-fd-muted-foreground mt-2 text-sm">{useCase.description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
