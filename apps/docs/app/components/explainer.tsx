import { Fragment, useState } from "react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { Cake } from "@/components/logos/cakes";
import { Link } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const examples = {
  "ai-chat": {
    label: "AI Chat",
    link: "https://github.com/rejot-dev/fragno/tree/main/example-fragments/chatno",
    linkCta: "Example code",
    frontend: {
      code: `return {
  useChat: b.createMutator("POST", "/chat/:id"),
};`,
    },
    fragment: {
      code: `const { mutate, loading, error } = useChat();

const { response } = await mutate({
  body: { prompt },
});`,
    },
    backend: {
      code: `defineRoute({
  method: "POST",
  path: "/chat/:id",
  handler: async ({ input }, { json }) => {
    return json({
      response: generate(input.prompt),
    });
  },
});`,
    },
    database: {
      code: `schema((s) => {
  return s.addTable("conversation", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("messages", column("json"))
      .addColumn("createdAt", column("timestamp"));
  });
});`,
    },
  },
  stripe: {
    label: "Stripe SDK",
    link: "/docs/stripe/quickstart",
    linkCta: "Start using this fragment today",
    frontend: {
      code: `return {
  upgradeSubscription: b.createMutator("POST", "/upgrade"),
  useSubscription: b.createHook("/subscriptions"),
};`,
    },
    fragment: {
      code: `const { mutate, loading } = upgradeSubscription();

const { url, redirect } = await mutate({
  body: { priceId: "price_123" },
});

if (redirect) {
  window.location.href = url;
}`,
    },
    backend: {
      code: `defineRoute({
  method: "POST",
  path: "/upgrade",
  handler: async ({ input }, { json }) => {
    const session = checkout.create(input);
    return json({
      url: session.url,
      redirect: true,
    });
  },
});`,
    },
    database: {
      code: `schema((s) => {
  return s.addTable("subscription", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("status", column("string"))
      .addColumn("createdAt", column("timestamp"));
  });
});`,
    },
  },
  "better-auth": {
    label: "Better-Auth",
    frontend: {
      code: `return {
  useSignIn: b.createMutator("POST", "/auth/sign-in"),
  useUser: b.createHook("/auth/users"),
};`,
    },
    fragment: {
      code: `const { mutate: signIn, loading } = useSignIn();

await signIn({
  body: { email, password },
});`,
    },
    backend: {
      code: `defineRoute({
  method: "POST",
  path: "/auth/sign-in",
  handler: async ({ input }, { json }) => {
    const session = await auth.api.signInEmail({
      body: input.body,
    });
    return json({ session });
  },
});`,
    },
    database: {
      code: `schema((s) => {
  return s
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("name", column("string"));
    })
    .addTable("session", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("userId", column("string"))
        .addColumn("expiresAt", column("timestamp"));
    });
});`,
    },
  },
};

type ExampleKey = keyof typeof examples;

const layers = [
  {
    id: "database",
    label: "Database",
    subLabel: "Define schemas, query with type safety, and write directly to the user's database.",
    layerVariant: "bottom" as const,
    variant: "cake-layer" as const,
  },
  {
    id: "backend",
    label: "Backend",
    subLabel: "API routes are the central abstraction, with input validation included.",
    layerVariant: "middle" as const,
    variant: "cake-layer" as const,
  },
  {
    id: "frontend",
    label: "Frontend",
    subLabel: "Hooks are derived from backend routes for all frontend frameworks.",
    layerVariant: "top" as const,
    variant: "cake-layer" as const,
  },
  {
    id: "fragment",
    label: "Fragment",
    subLabel: "Integration becomes as simple as using a hook.",
    layerVariant: "top" as const,
    variant: "cake-slice" as const,
  },
];

export function FragnoExplainer() {
  const [activeExample, setActiveExample] = useState<ExampleKey>("ai-chat");
  const example = examples[activeExample];

  const handleExampleChange = (newExample: ExampleKey) => {
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        setActiveExample(newExample);
      });
    } else {
      setActiveExample(newExample);
    }
  };

  return (
    <section className="w-full max-w-5xl space-y-12">
      <style>{`
        ::view-transition-old(layer-card-0),
        ::view-transition-new(layer-card-0) {
          animation-duration: 200ms;
          animation-delay: 0ms;
        }
        ::view-transition-old(layer-card-1),
        ::view-transition-new(layer-card-1) {
          animation-duration: 200ms;
          animation-delay: 100ms;
        }
        ::view-transition-old(layer-card-2),
        ::view-transition-new(layer-card-2) {
          animation-duration: 200ms;
          animation-delay: 200ms;
        }
        ::view-transition-old(layer-card-3),
        ::view-transition-new(layer-card-3) {
          animation-duration: 200ms;
          animation-delay: 300ms;
        }
      `}</style>
      <h2 className="text-center text-3xl font-bold tracking-tight md:text-4xl">
        Ship the next{" "}
        <Select value={activeExample} onValueChange={(v) => handleExampleChange(v as ExampleKey)}>
          <SelectTrigger className="inline-flex h-auto w-auto border-blue-600 px-3 py-1 text-3xl font-bold text-blue-600 shadow-none md:text-4xl dark:text-blue-400">
            <SelectValue>{examples[activeExample].label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(examples).map(([key, { label }]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>{" "}
        with Fragno
      </h2>

      <div className="flex flex-col gap-10 bg-cover bg-center bg-no-repeat md:bg-[url(/road-bg-blue.svg)]">
        {layers.map(({ id, label, subLabel, variant, layerVariant }, index) => (
          <Fragment key={id}>
            {/* Layer card */}
            <div
              className={`relative flex w-full max-w-xl flex-col gap-5 rounded-2xl bg-gray-100/85 p-6 shadow-sm backdrop-blur-md dark:bg-slate-900/75 ${
                index % 2 === 0 ? "md:self-start" : "md:self-end"
              }`}
              style={{
                viewTransitionName: `layer-card-${index}`,
              }}
            >
              {/* Stamp icon in top-right corner */}
              <Cake
                variant={variant}
                layerVariant={layerVariant}
                className={`dark:drop-shadow-slate-600 absolute right-0 top-0 z-10 -translate-y-1/2 md:translate-x-1/4 dark:drop-shadow-md ${index === layers.length - 1 ? "size-40" : "size-24"}`}
              />

              {/* Card content: title, subtitle, code */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <span className="text-2xl font-medium">{label}</span>
                  <span className="text-fd-muted-foreground text-lg">{subLabel}</span>
                </div>

                <FragnoCodeBlock
                  lang="tsx"
                  className="rounded-xl"
                  allowCopy={false}
                  code={example[id as "frontend" | "backend" | "database" | "fragment"].code}
                />
              </div>

              {/* Bottom row: button (only for fragment layer) */}
              {index === layers.length - 1 && example?.link && (
                <Link
                  to={example.link}
                  className="inline-flex max-w-md items-center justify-center gap-4 self-center rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
                >
                  {example.linkCta}
                  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                    />
                  </svg>
                </Link>
              )}
            </div>

            {/* Separator */}
            {/*{index < layers.length - 1 && (
              <div className="flex items-center justify-center py-2">
                <span className="text-3xl font-bold text-gray-400">
                  {index < layers.length - 2 ? "+" : "="}
                </span>
              </div>
            )}*/}
          </Fragment>
        ))}
      </div>

      {/* Cake collage */}
      <div className="flex items-end justify-center">
        <Cake
          variant="cake-full"
          className="dark:drop-shadow-slate-600 size-48 md:size-64 dark:drop-shadow-md"
        />
        <Cake
          variant="cake-crumbs"
          className="dark:drop-shadow-slate-600 mr-2 size-12 md:size-16 dark:drop-shadow-md"
        />
        <Cake
          variant="cake-slice"
          className="dark:drop-shadow-slate-600 size-32 translate-y-4 md:size-44 md:translate-y-6 dark:drop-shadow-md"
        />
      </div>
    </section>
  );
}
