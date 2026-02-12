import { cn } from "@/lib/cn";
import { Kysely } from "@/components/logos/frameworks/kysely";
import { Drizzle } from "@/components/logos/frameworks/drizzle";
import { Prisma } from "@/components/logos/frameworks/prisma";

export function DatabaseSupport({ className }: { className?: string }) {
  const orms = [
    { name: "Kysely", element: <Kysely className="size-6" /> },
    { name: "Drizzle", element: <Drizzle className="size-6" /> },
    { name: "Prisma", element: <Prisma className="size-6" /> },
  ];

  const databases = ["PostgreSQL", "MySQL / MariaDB", "SQLite"];

  return (
    <section className={cn("w-full max-w-5xl space-y-6", className)}>
      <div className="space-y-3 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Database Support</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl text-lg">
          Fragments ship schema outputs for your ORM workflow and integrate with the databases you
          already run.
        </p>
        <p className="text-fd-muted-foreground text-sm">
          <a
            href="/docs/fragno/for-users/database-fragments/overview"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Database Adapters
          </a>
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        {orms.map((orm) => (
          <div
            key={orm.name}
            className="flex items-center gap-2 rounded-full border border-black/5 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-200"
          >
            <span className="text-slate-500 dark:text-slate-300">{orm.element}</span>
            {orm.name}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {databases.map((db) => (
          <span
            key={db}
            className="rounded-full border border-slate-200/80 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300"
          >
            {db}
          </span>
        ))}
      </div>
    </section>
  );
}
