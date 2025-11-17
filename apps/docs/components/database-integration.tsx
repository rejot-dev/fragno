"use client";

import { Database, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Kysely } from "@/components/logos/frameworks/kysely";
import { Drizzle } from "@/components/logos/frameworks/drizzle";
import { Carousel, CarouselContent, CarouselItem } from "@/components/ui/carousel";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { useState } from "react";
import type { CarouselApi } from "@/components/ui/carousel";

export default function DatabaseIntegration() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [carouselApi, setCarouselApi] = useState<CarouselApi>();

  const carouselItems = [
    {
      id: "schema",
      title: "Define Your Schema",
      subtitle: "Type-safe tables with automatic migrations and support for indexes & relations",
      content: (
        <FragnoCodeBlock
          lang="typescript"
          code={`import { schema, idColumn, column }
  from "@fragno-dev/db/schema";

export const commentSchema = schema((s) => {
  return s
    .addTable("comment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("content", column("string"))
        .addColumn("userId", column("string"))
        .addColumn("postId", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp")
            .defaultTo((b) => b.now())
        )
        .createIndex("idx_post", ["postId"]);
    })
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"));
    })
    .addReference("author", {
      type: "one",
      from: { table: "comment", column: "userId" },
      to: { table: "user", column: "id" }
    });
});`}
          codeblock={{
            className: "text-sm",
          }}
        />
      ),
    },
    {
      id: "querying",
      title: "Query with Type Safety",
      subtitle: "Joins, filtering, and cursor-based pagination",
      content: (
        <FragnoCodeBlock
          lang="typescript"
          code={`// Find comments with author data
const comments = await orm.find(
  "comment",
  (b) =>
    b
      .whereIndex("idx_post", (eb) =>
        eb("postId", "=", postId)
      )
      .orderByIndex("idx_created", "desc")
      .join((j) =>
        j.author((authorBuilder) =>
          authorBuilder.select(["name"])
        )
      )
      .pageSize(20)
);

// Fully typed results
for (const comment of comments) {
  console.log(comment.content);
  console.log(comment.author?.name);
  //                     ^? { name: string } | null
}
`}
          codeblock={{
            className: "text-sm",
          }}
        />
      ),
    },
    {
      id: "transactions",
      title: "Atomic Transactions",
      subtitle: "Optimistic concurrency control with version checking",
      content: (
        <FragnoCodeBlock
          lang="typescript"
          code={`const uow = orm.createUnitOfWork();

// Phase 1: Retrieve with version info
uow.find("user", (b) =>
  b.whereIndex("primary", (eb) =>
    eb("id", "=", userId)
  )
);
const [users] = await uow.executeRetrieve();

// Phase 2: Update with optimistic lock
const user = users[0];
uow.update("user", user.id, (b) =>
  b
    .set({ balance: user.balance + 100 })
    .check() // Fails if version changed
);

const { success } = await uow.executeMutations();
if (!success) {
  // Concurrent modification detected
  console.error("Retry transaction");
}`}
          codeblock={{
            className: "text-sm",
          }}
        />
      ),
    },
    {
      id: "testing",
      title: "Test Everything",
      subtitle: "In-memory database for fast tests",
      content: (
        <FragnoCodeBlock
          lang="typescript"
          code={`import { buildDatabaseFragmentsTest }
  from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";

describe("auth fragment", async () => {
  const { fragments, test } =
    await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-sqlite" })
      .withFragment("auth",
        instantiate(authFragmentDefinition).withRoutes(routes).withConfig({}),
        { definition: authFragmentDefinition }
      )
      .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates user and session", async () => {
    const response = await fragments.auth.callRoute(
      "POST",
      "/signup",
      {
        body: {
          email: "test@test.com",
          password: "password"
        }
      }
    );

    expect(response.data).toMatchObject({
      sessionId: expect.any(String),
      userId: expect.any(String)
    });
  });
});`}
          codeblock={{
            className: "text-sm",
          }}
        />
      ),
    },
  ];

  return (
    <section className="w-full">
      <div className="mb-12 text-center">
        <div className="mb-4 inline-flex items-center gap-3 rounded-xl bg-slate-100 px-4 py-2 shadow-sm dark:bg-slate-900">
          <Database className="size-5 text-slate-700 dark:text-slate-300" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Database Layer
          </span>
        </div>
        <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
          Agnostic Data Persistence
        </h2>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl text-lg">
          Define schemas, query with type safety, and write directly to the user's database
        </p>
      </div>

      <Carousel
        opts={{
          align: "center",
          loop: false,
        }}
        className="w-full"
        setApi={(api) => {
          if (!api) {
            return;
          }
          setCarouselApi(api);
          api.on("select", () => {
            setActiveIndex(api.selectedScrollSnap());
          });
          setActiveIndex(api.selectedScrollSnap());
        }}
      >
        <CarouselContent className="ml-0">
          {carouselItems.map((item) => (
            <CarouselItem key={item.id} className="basis-[90%] pl-0 pr-6 sm:basis-[600px]">
              <div className="h-full space-y-4">
                <div className="space-y-1.5">
                  <h3 className="text-xl font-bold tracking-tight">{item.title}</h3>
                  <p className="text-fd-muted-foreground text-sm">{item.subtitle}</p>
                </div>
                <div>{item.content}</div>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <div className="mt-8 flex items-center justify-center gap-2.5">
          {carouselItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                carouselApi?.scrollTo(index);
              }}
              className={`rounded-full transition-all duration-300 ${
                activeIndex === index
                  ? "h-2.5 w-2.5 bg-slate-700 dark:bg-slate-300"
                  : "h-2 w-2 bg-slate-300 hover:bg-slate-400 dark:bg-slate-600 dark:hover:bg-slate-500"
              }`}
              aria-label={`Go to ${item.title}`}
              aria-current={activeIndex === index ? "true" : "false"}
            />
          ))}
        </div>
      </Carousel>

      <div className="mt-12 flex flex-col items-center justify-center gap-6 sm:flex-row">
        <div className="flex items-center gap-3">
          <span className="text-fd-muted-foreground text-sm font-medium">Works with</span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 shadow-sm ring-1 ring-black/5 dark:bg-slate-900 dark:ring-white/10">
              <Kysely className="size-5" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Kysely</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 shadow-sm ring-1 ring-black/5 dark:bg-slate-900 dark:ring-white/10">
              <Drizzle className="size-5" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Drizzle
              </span>
            </div>
          </div>
        </div>
        <Link
          href="/docs/fragno/for-library-authors/database-integration/overview"
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-slate-800 hover:shadow-md dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
        >
          Learn More
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}
