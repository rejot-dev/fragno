import { Link } from "react-router";

export function meta() {
  return [
    { title: "Upload Fragment Example" },
    { name: "description", content: "Fragno upload fragment demo" },
  ];
}

const cards = [
  {
    title: "S3-backed storage",
    description:
      "Send files straight from the browser to S3-compatible storage with multipart uploads and progress updates.",
    href: "/direct",
    accent: "from-amber-400/20 via-orange-400/10 to-amber-500/20",
  },
  {
    title: "File storage",
    description:
      "Stream files through the server into a local filesystem directory. Great for local development.",
    href: "/proxy",
    accent: "from-emerald-400/20 via-teal-400/10 to-emerald-500/20",
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-8 shadow-sm">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
              Fragno Upload Fragment
            </p>
            <h1 className="mt-4 text-4xl font-semibold text-slate-900">
              Ship file uploads with S3-backed storage or file storage.
            </h1>
            <p className="mt-4 text-base text-slate-600">
              This example shows how to create uploads, stream bytes, track progress, and list files
              with prefix queries. Use the S3-backed storage flow for direct-to-bucket multipart
              uploads, or the file storage flow when you want the server to stream to local disk.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50 p-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Mode env vars
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  S3-backed storage
                </p>
                <ul className="mt-2 space-y-2 text-sm text-slate-600">
                  <li>UPLOAD_S3_BUCKET</li>
                  <li>UPLOAD_S3_ENDPOINT</li>
                  <li>UPLOAD_S3_REGION</li>
                  <li>UPLOAD_S3_ACCESS_KEY_ID</li>
                  <li>UPLOAD_S3_SECRET_ACCESS_KEY</li>
                  <li>UPLOAD_S3_PATH_STYLE (optional)</li>
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  File storage
                </p>
                <ul className="mt-2 space-y-2 text-sm text-slate-600">
                  <li>UPLOAD_PROXY_DIR (optional)</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        {cards.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="group rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
          >
            <div className={`rounded-2xl bg-gradient-to-br ${card.accent} p-6`}>
              <h2 className="text-2xl font-semibold text-slate-900">{card.title}</h2>
              <p className="mt-3 text-sm text-slate-600">{card.description}</p>
              <span className="mt-6 inline-flex items-center text-sm font-semibold text-slate-900">
                Open demo →
              </span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
