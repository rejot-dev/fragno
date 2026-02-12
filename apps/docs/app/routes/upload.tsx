import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, Database, FolderUp, Server, Terminal, Upload } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { FragmentSubnav } from "@/components/fragment-subnav";

export function meta() {
  return [
    { title: "Upload Fragment" },
    {
      name: "description",
      content:
        "Direct and proxy uploads with storage adapters, file metadata, and progress tracking.",
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

type Adapter = {
  id: string;
  label: string;
  description: string;
  code: string;
};

const features: Feature[] = [
  {
    title: "File + upload model",
    description: "Track upload lifecycle and file metadata with durable records.",
    icon: <Database className="size-5" />,
  },
  {
    title: "Multiple upload strategies",
    description: "Direct single/multipart or server-streamed proxy uploads.",
    icon: <Upload className="size-5" />,
  },
  {
    title: "Storage adapters",
    description: "S3/R2-compatible storage and Node filesystem adapters.",
    icon: <Server className="size-5" />,
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
    description: "Choose a storage adapter and mount the routes.",
    lang: "ts",
    code: `import { createUploadFragment, createFilesystemStorageAdapter } from "@fragno-dev/upload";
import { migrate } from "@fragno-dev/db";

const storage = createFilesystemStorageAdapter({ rootDir: "./uploads" });

const fragment = createUploadFragment(
  { storage },
  {
    databaseAdapter,
    mountRoute: "/api/uploads",
  },
);

await migrate(fragment);`,
  },
  {
    title: "3. Create a client",
    description: "Generate typed helpers for direct and proxy uploads.",
    lang: "ts",
    code: `import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export const uploadClient = createUploadFragmentClient({
  mountRoute: "/api/uploads",
});`,
  },
];

const storageAdapters: Adapter[] = [
  {
    id: "s3",
    label: "S3-compatible",
    description: "Works with AWS S3 and compatible providers like R2.",
    code: `import { createS3CompatibleStorageAdapter } from "@fragno-dev/upload";

const storage = createS3CompatibleStorageAdapter({
  bucket: process.env.UPLOAD_S3_BUCKET!,
  endpoint: process.env.UPLOAD_S3_ENDPOINT!,
  signer,
});`,
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    description: "R2 defaults on top of the S3-compatible signer.",
    code: `import { createR2StorageAdapter } from "@fragno-dev/upload";

const storage = createR2StorageAdapter({
  bucket: process.env.R2_BUCKET!,
  endpoint: process.env.R2_ENDPOINT!,
  signer,
});`,
  },
  {
    id: "fs",
    label: "Filesystem",
    description: "Great for local dev or small deployments.",
    code: `import { createFilesystemStorageAdapter } from "@fragno-dev/upload";

const storage = createFilesystemStorageAdapter({
  rootDir: "./uploads",
});`,
  },
];

const usageSnippet = `const { useUploadHelpers } = uploadClient;

const helpers = useUploadHelpers();
await helpers.createUploadAndTransfer(file, {
  keyParts: ["users", userId, "avatar"],
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
    title: "Large assets",
    description: "Use multipart uploads for big files with resumable transfers.",
  },
  {
    title: "Multi-tenant storage",
    description: "Store files in R2 or S3 with keys that map to orgs or projects.",
  },
];

export default function UploadPage() {
  const [activeAdapter, setActiveAdapter] = useState(storageAdapters[0].id);
  const selectedAdapter =
    storageAdapters.find((adapter) => adapter.id === activeAdapter) ?? storageAdapters[0];

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
              Direct and proxy uploads with storage adapters, metadata, and progress tracking.
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
              <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Install
              </p>
              <FragnoCodeBlock
                lang="bash"
                code="npm install @fragno-dev/upload"
                allowCopy
                className="rounded-xl"
              />
              <p className="text-fd-muted-foreground text-xs">
                Requires a Fragno database adapter to store upload and file records.
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
                  Upload modes
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  Pick direct or server-streamed based on security needs.
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4">
              <div className="rounded-xl border border-black/5 p-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Direct</p>
                <p className="text-fd-muted-foreground text-sm">
                  Signed URLs to S3/R2 for large files and efficient transfers.
                </p>
              </div>
              <div className="rounded-xl border border-black/5 p-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Proxy</p>
                <p className="text-fd-muted-foreground text-sm">
                  Server-streamed uploads for private storage or small files.
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
                Configure storage, mount routes, and ship upload flows.
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
                  The client helper picks direct or server-streamed uploads automatically.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock lang="ts" code={usageSnippet} allowCopy className="rounded-xl" />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Storage adapters
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Switch adapters without changing fragment APIs.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {storageAdapters.map((adapter) => {
                    const isActive = adapter.id === selectedAdapter.id;
                    return (
                      <button
                        key={adapter.id}
                        type="button"
                        onClick={() => setActiveAdapter(adapter.id)}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                          isActive
                            ? "border-cyan-400/40 text-cyan-700 dark:text-cyan-200"
                            : "border-slate-200 text-slate-600 dark:border-white/10 dark:text-slate-300"
                        }`}
                      >
                        {adapter.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-fd-muted-foreground mt-3 text-sm">
                  {selectedAdapter.description}
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock
                    lang="ts"
                    code={selectedAdapter.code}
                    allowCopy
                    className="rounded-xl"
                  />
                </div>
                <Link
                  to="/docs/upload/adapters"
                  className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-cyan-600 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-200"
                >
                  Adapter docs
                  <ArrowRight className="size-4" />
                </Link>
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
