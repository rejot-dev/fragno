import { Drizzle } from "@/components/logos/frameworks/drizzle";
import { Kysely } from "@/components/logos/frameworks/kysely";
import { Prisma } from "@/components/logos/frameworks/prisma";

function LetterMark({ letter }: { letter: string }) {
  return (
    <div className="flex size-12 items-center justify-center rounded-md border border-(--editorial-ghost-border) text-2xl font-bold text-(--editorial-muted)">
      {letter}
    </div>
  );
}

const items = [
  { name: "Kysely", element: <Kysely className="size-12" /> },
  { name: "Drizzle", element: <Drizzle className="size-12" /> },
  { name: "Prisma", element: <Prisma className="size-12" /> },
  { name: "PostgreSQL", element: <LetterMark letter="P" /> },
  { name: "SQLite", element: <LetterMark letter="S" /> },
  { name: "MySQL", element: <LetterMark letter="M" /> },
];

export default function DatabaseSupport({ className }: { className?: string }) {
  return (
    <section className={className}>
      <div className="max-w-4xl">
        <div className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] shadow-[0_24px_48px_rgb(15_23_42/0.08)] backdrop-blur-md dark:shadow-[0_24px_48px_rgb(2_6_23/0.28)]">
          <div className="space-y-6 p-6 md:p-10">
            <div className="grid w-full grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-6">
              {items.map((item, index) => (
                <div key={item.name} className="relative flex flex-col items-center gap-2">
                  {index === 3 ? (
                    <div
                      className="absolute -ml-3 hidden h-16 w-px bg-(--editorial-ghost-border) opacity-70 md:block"
                      aria-hidden
                    />
                  ) : null}
                  <div
                    className="rounded-md p-1"
                    style={{
                      filter: "grayscale(1) saturate(0)",
                      opacity: 0.85,
                    }}
                    aria-label={`${item.name} logo`}
                  >
                    {item.element}
                  </div>
                  <span className="text-xs font-medium text-(--editorial-muted)">{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
